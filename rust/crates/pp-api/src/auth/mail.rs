use anyhow::Result;
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor, message::Mailbox,
    transport::smtp::authentication::Credentials,
};
use std::time::Duration;

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
pub struct ResetMailer(Option<(AsyncSmtpTransport<Tokio1Executor>, Mailbox)>);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    Sent,
    Unsent,
    FailedOrUnknown,
}
impl ResetMailer {
    pub fn disabled() -> Self {
        Self(None)
    }
    pub fn smtp(config: SmtpConfig) -> Result<Self> {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let builder = match config.security {
            SmtpSecurity::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host)?,
            SmtpSecurity::StartTls => {
                AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)?
            }
        };
        let mut builder = builder
            .port(config.port)
            .timeout(Some(Duration::from_secs(15)));
        if let Some((user, password)) = config.credentials {
            builder = builder.credentials(Credentials::new(user, password));
        }
        Ok(Self(Some((builder.build(), config.from.parse()?))))
    }
    pub(super) fn configured(&self) -> bool {
        self.0.is_some()
    }
    pub async fn deliver(&self, to: &str, url: &str) -> Delivery {
        let Some((transport, from)) = &self.0 else {
            return Delivery::Unsent;
        };
        let Ok(to) = to.parse::<Mailbox>() else {
            return failed("invalid_recipient");
        };
        let Ok(message) = Message::builder().from(from.clone()).to(to).subject("Reset your Print Partner password").body(format!("You requested a password reset for your Print Partner account.\n\nOpen this link to choose a new password (valid for 1 hour):\n{url}\n\nIf you did not request this, you can ignore this email.\n")) else { return failed("message_build"); };
        match tokio::time::timeout(Duration::from_secs(15), transport.send(message)).await {
            Ok(Ok(_)) => Delivery::Sent,
            Ok(Err(error)) => failed(if error.is_timeout() {
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
            Err(_) => failed("timeout"),
        }
    }
}

fn failed(error_class: &str) -> Delivery {
    // Never format the provider error: it can contain recipient or message data.
    log::warn!(target: "pp_api::reset_mail", "Password reset mail delivery failed; provider=smtp error_class={error_class}");
    Delivery::FailedOrUnknown
}

#[cfg(test)]
#[path = "mail_tests.rs"]
mod tests;
