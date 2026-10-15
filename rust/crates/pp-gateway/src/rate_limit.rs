use axum::{
    body::Body,
    http::{HeaderValue, Response, StatusCode},
    response::IntoResponse,
};
use serde::Serialize;
use std::time::Duration;
use tokio::time::Instant;

#[derive(Default)]
pub(super) struct Budgets {
    app: Option<Window>,
    media: Option<Window>,
}
struct Window {
    start: Instant,
    used: u16,
}
#[derive(Serialize)]
pub(super) struct Quota {
    remaining: u16,
    reset: u64,
    exceeded: bool,
}
impl Budgets {
    pub fn consume(&mut self, media: bool) -> Quota {
        let slot = if media {
            &mut self.media
        } else {
            &mut self.app
        };
        let now = Instant::now();
        let window = slot.get_or_insert(Window {
            start: now,
            used: 0,
        });
        if now.duration_since(window.start) >= Duration::from_secs(60) {
            *window = Window {
                start: now,
                used: 0,
            };
        }
        window.used = window.used.saturating_add(1);
        Quota {
            remaining: 1000u16.saturating_sub(window.used),
            reset: (Duration::from_secs(60) - now.duration_since(window.start))
                .as_nanos()
                .div_ceil(1_000_000_000) as u64,
            exceeded: window.used > 1000,
        }
    }
}
impl Quota {
    pub fn apply(&self, response: &mut Response<Body>) {
        for (name, value) in [
            ("x-ratelimit-limit", 1000),
            ("x-ratelimit-remaining", u64::from(self.remaining)),
            ("x-ratelimit-reset", self.reset),
        ] {
            response
                .headers_mut()
                .insert(name, HeaderValue::from(value));
        }
        if self.exceeded {
            response
                .headers_mut()
                .insert("retry-after", HeaderValue::from(self.reset));
        }
    }
    pub fn rejection(&self, head: bool) -> Option<Response<Body>> {
        if !self.exceeded {
            return None;
        }
        let after = match self.reset {
            60 => "1 minute".to_owned(),
            1 => "1 second".to_owned(),
            n => format!("{n} seconds"),
        };
        #[derive(Serialize)]
        struct Throttled {
            #[serde(rename = "statusCode")]
            status_code: u16,
            error: &'static str,
            message: String,
        }
        let mut response = (
            StatusCode::TOO_MANY_REQUESTS,
            axum::Json(Throttled {
                status_code: 429,
                error: "Too Many Requests",
                message: format!("Rate limit exceeded, retry in {after}"),
            }),
        )
            .into_response();
        response.headers_mut().insert(
            "content-type",
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        if let Some(length) = http_body::Body::size_hint(response.body()).exact() {
            response
                .headers_mut()
                .insert("content-length", HeaderValue::from(length));
        }
        response
            .headers_mut()
            .insert("cache-control", HeaderValue::from_static("no-store"));
        if head {
            *response.body_mut() = Body::empty();
        }
        self.apply(&mut response);
        Some(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn ticket_t_3_drain_rate_windows_are_shared_bounded_and_reset() {
        let mut budgets = Budgets::default();
        for remaining in (0..1000).rev() {
            let quota = budgets.consume(false);
            assert_eq!(quota.remaining, remaining);
            assert!(!quota.exceeded);
        }
        assert!(budgets.consume(false).exceeded);
        assert_eq!(budgets.consume(true).remaining, 999);
        tokio::time::advance(Duration::from_secs(59)).await;
        assert_eq!(budgets.consume(false).reset, 1);
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(budgets.consume(false).remaining, 999);
        assert_eq!(budgets.consume(true).remaining, 999);
    }
}
