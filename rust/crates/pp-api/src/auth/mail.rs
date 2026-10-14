use anyhow::Result;
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor, message::Mailbox,
    transport::smtp::authentication::Credentials,
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

pub(super) const DELIVERY_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy)]
pub enum SmtpSecurity {
    Tls,
    StartTls,
}

pub struct SmtpConfig {
    pub security: SmtpSecurity,
    pub host: String,
    pub port: u16,
    pub from: String,
    pub credentials: Option<(String, String)>,
}
#[derive(Clone)]
pub struct ResetMailer {
    transport: Option<(AsyncSmtpTransport<Tokio1Executor>, Mailbox)>,
    failures: Arc<AtomicU64>,
    deliveries: Arc<Mutex<tokio::task::JoinSet<()>>>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    Sent,
    Unsent,
    FailedOrUnknown,
}
impl ResetMailer {
    fn new(transport: Option<(AsyncSmtpTransport<Tokio1Executor>, Mailbox)>) -> Self {
        Self {
            transport,
            failures: Arc::default(),
            deliveries: Arc::default(),
        }
    }

    /// Number of failed or uncertain deliveries, shared by all clones.
    /// No recipient, reset token, or URL is retained in this counter.
    pub fn delivery_failure_count(&self) -> u64 {
        self.failures.load(Ordering::Relaxed)
    }

    pub(super) fn schedule_reset(
        &self,
        email: String,
        url: Option<String>,
        deadline: tokio::time::Instant,
        permit: tokio::sync::OwnedSemaphorePermit,
    ) {
        let mail = self.clone();
        let mut deliveries = match self.deliveries.lock() {
            Ok(deliveries) => deliveries,
            Err(_) => panic!("reset delivery lock poisoned"),
        };
        while let Some(result) = deliveries.try_join_next() {
            if result.is_err() {
                self.failed("delivery_task");
            }
        }
        deliveries.spawn(async move {
            let _permit = permit;
            tokio::join!(tokio::time::sleep_until(deadline), async {
                if let Some(url) = url {
                    mail.deliver_until(&email, &url, deadline).await;
                }
            });
        });
    }

    /// Call after the HTTP server has stopped accepting and drained requests,
    /// before shutting down the runtime. Each delivery has its original deadline.
    pub async fn drain_deliveries(&self) {
        let mut deliveries = {
            let mut pending = match self.deliveries.lock() {
                Ok(pending) => pending,
                Err(_) => panic!("reset delivery lock poisoned"),
            };
            std::mem::take(&mut *pending)
        };
        while let Some(result) = deliveries.join_next().await {
            if result.is_err() {
                self.failed("delivery_task");
            }
        }
    }

    fn failed(&self, error_class: &str) -> Delivery {
        self.failures.fetch_add(1, Ordering::Relaxed);
        // Never format the provider error: it can contain recipient or message data.
        log::warn!(target: "pp_api::reset_mail", "Password reset mail delivery failed; provider=smtp error_class={error_class}");
        Delivery::FailedOrUnknown
    }

    pub fn disabled() -> Self {
        Self::new(None)
    }
    pub fn smtp(config: SmtpConfig) -> Result<Self> {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let builder = match config.security {
            SmtpSecurity::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host)?,
            SmtpSecurity::StartTls => {
                AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)?
            }
        };
        let mut builder = builder.port(config.port).timeout(Some(DELIVERY_TIMEOUT));
        if let Some((user, password)) = config.credentials {
            builder = builder.credentials(Credentials::new(user, password));
        }
        Ok(Self::new(Some((builder.build(), config.from.parse()?))))
    }
    pub(super) fn configured(&self) -> bool {
        self.transport.is_some()
    }
    pub async fn deliver(&self, to: &str, url: &str) -> Delivery {
        self.deliver_until(to, url, tokio::time::Instant::now() + DELIVERY_TIMEOUT)
            .await
    }
    pub(super) async fn deliver_until(
        &self,
        to: &str,
        url: &str,
        deadline: tokio::time::Instant,
    ) -> Delivery {
        let Some((transport, from)) = &self.transport else {
            return Delivery::Unsent;
        };
        let Ok(to) = to.parse::<Mailbox>() else {
            return self.failed("invalid_recipient");
        };
        let Ok(message) = Message::builder().from(from.clone()).to(to).subject("Reset your Print Partner password").body(format!("You requested a password reset for your Print Partner account.\n\nOpen this link to choose a new password (valid for 1 hour):\n{url}\n\nIf you did not request this, you can ignore this email.\n")) else { return self.failed("message_build"); };
        match tokio::time::timeout_at(deadline, transport.send(message)).await {
            Ok(Ok(_)) => Delivery::Sent,
            Ok(Err(error)) => self.failed(if error.is_timeout() {
                "timeout"
            } else if error.is_permanent() {
                "smtp_permanent"
            } else if error.is_transient() {
                "smtp_transient"
            } else if error.is_tls() {
                "tls"
            } else if error.is_response() {
                "smtp_response"
            } else if error.is_client() {
                "client"
            } else {
                "transport"
            }),
            Err(_) => self.failed("timeout"),
        }
    }
}

#[cfg(test)]
#[path = "tests/mail_tests.rs"]
mod tests;
