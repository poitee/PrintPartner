//! Status-only HTTP: resolve once, check every answer, connect only to checked IPs.
//! LAN/loopback printers are intentional; metadata/link-local, unspecified,
//! multicast and reserved targets are forbidden. No proxy, redirects or TLS downgrade.
use anyhow::{Context, Result, ensure};
use axum::http::{Request, Uri};
use http_body_util::{BodyExt, Empty, Limited};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use std::{
    future::Future,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::net::TcpStream;

pub type Resolution = Pin<Box<dyn Future<Output = Result<Vec<IpAddr>>> + Send>>;
pub trait Resolver: Send + Sync {
    fn resolve(&self, host: String) -> Resolution;
}
pub struct SystemResolver;
impl Resolver for SystemResolver {
    fn resolve(&self, host: String) -> Resolution {
        Box::pin(async move {
            Ok(tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .map(|a| a.ip())
                .collect())
        })
    }
}

pub fn permitted(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            a != 0
                && a < 224
                && !(a == 169 && b == 254)
                && ip != std::net::Ipv4Addr::new(100, 100, 100, 200)
        }
        IpAddr::V6(ip) => {
            if let Some(ip) = ip.to_ipv4_mapped() {
                return permitted(IpAddr::V4(ip));
            }
            // Only global unicast, ULA and explicit loopback; deny embedded IPv4
            // translation/transition ranges as well as link-local/multicast.
            let first = ip.segments()[0];
            (ip.is_loopback()
                || (first & 0xe000 == 0x2000
                    && first != 0x2002
                    && ip.segments()[..2] != [0x2001, 0])
                || first & 0xfe00 == 0xfc00)
                && ip != "fd00:ec2::254".parse::<std::net::Ipv6Addr>().unwrap()
        }
    }
}

trait WallClock: Send + Sync {
    fn now(&self) -> SystemTime;
}
struct SystemClock;
impl WallClock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}
#[derive(Clone)]
pub struct HttpGuard {
    resolver: Arc<dyn Resolver>,
    deadline: Duration,
    max_body: usize,
    clock: Arc<dyn WallClock>,
}
#[derive(Debug)]
pub struct HttpReply {
    pub status: u16,
    pub body: Vec<u8>,
}
impl HttpGuard {
    pub fn new(resolver: Arc<dyn Resolver>, deadline: Duration, max_body: usize) -> Result<Self> {
        ensure!(
            !deadline.is_zero() && deadline <= Duration::from_secs(30),
            "Invalid deadline"
        );
        ensure!(
            max_body > 0 && max_body <= 2 * 1024 * 1024,
            "Invalid body limit"
        );
        Ok(Self {
            resolver,
            deadline,
            max_body,
            clock: Arc::new(SystemClock),
        })
    }
    pub async fn get(&self, url: &str, api_key: Option<&str>) -> Result<HttpReply> {
        let deadline = self.clock.now() + self.deadline;
        // Tokio's monotonic clock may pause during system sleep. Also bound wall
        // time, so resumed requests are dropped instead of publishing stale data.
        let wall_timeout = async {
            loop {
                if self.clock.now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50).min(self.deadline)).await;
            }
        };
        let result = tokio::time::timeout(self.deadline, async {
            tokio::select! { biased;
                _=wall_timeout=>anyhow::bail!("HTTP wall deadline"),
                result=self.get_inner(url,api_key)=>result,
            }
        })
        .await
        .context("HTTP deadline")?;
        ensure!(self.clock.now() < deadline, "HTTP wall deadline");
        result
    }

    async fn get_inner(&self, url: &str, api_key: Option<&str>) -> Result<HttpReply> {
        let uri: Uri = url.parse()?;
        ensure!(
            uri.scheme_str() == Some("http"),
            "Only explicit HTTP status URLs supported"
        );
        let authority = uri.authority().context("Missing host")?;
        ensure!(
            !authority.as_str().contains('@'),
            "Credentials in URL denied"
        );
        let host = uri
            .host()
            .context("Missing host")?
            .trim_start_matches('[')
            .trim_end_matches(']');
        ensure!(
            uri.port().is_none() || uri.port_u16().is_some(),
            "Invalid port"
        );
        let port = uri.port_u16().unwrap_or(80);
        ensure!(port != 0, "Invalid port");
        let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
            vec![ip]
        } else {
            self.resolver.resolve(host.into()).await?
        };
        ensure!(
            !addresses.is_empty()
                && addresses.len() <= 32
                && addresses.iter().all(|ip| permitted(*ip)),
            "Prohibited DNS answer"
        );
        // Race only the checked, pinned addresses. The request deadline bounds
        // the whole race, and dropping the JoinSet cancels every losing socket.
        let stream = connect_addresses(
            addresses
                .into_iter()
                .map(|ip| SocketAddr::new(ip, port))
                .collect(),
            TcpStream::connect,
        )
        .await?;
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
        let task = tokio::spawn(connection);
        // Abort on body/read timeout, cancellation, errors, and successful completion.
        struct Connection(tokio::task::JoinHandle<Result<(), hyper::Error>>);
        impl Drop for Connection {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        let _connection = Connection(task);
        let mut builder = Request::builder()
            .method("GET")
            .uri(uri.path_and_query().map_or("/", |p| p.as_str()))
            .header("host", authority.as_str())
            .header("connection", "close");
        if let Some(key) = api_key.filter(|key| !key.is_empty() && *key != "****") {
            let jwt = key.split('.').count() == 3
                && key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b));
            builder = if jwt {
                builder.header("authorization", format!("Bearer {key}"))
            } else {
                builder.header("x-api-key", key)
            };
        }
        let response = sender
            .send_request(builder.body(Empty::<Bytes>::new())?)
            .await?;
        let status = response.status().as_u16();
        let body = Limited::new(response.into_body(), self.max_body)
            .collect()
            .await
            .map_err(|_| anyhow::anyhow!("HTTP body unavailable or oversized"))?
            .to_bytes()
            .to_vec();
        Ok(HttpReply { status, body })
    }
}

async fn connect_addresses<T, F>(
    addresses: Vec<SocketAddr>,
    connect: impl Fn(SocketAddr) -> F,
) -> Result<T>
where
    T: Send + 'static,
    F: Future<Output = std::io::Result<T>> + Send + 'static,
{
    let mut attempts = tokio::task::JoinSet::new();
    for address in addresses {
        // SocketAddr cannot trigger another DNS lookup, including retries.
        attempts.spawn(connect(address));
    }
    while let Some(attempt) = attempts.join_next().await {
        if let Ok(Ok(stream)) = attempt {
            return Ok(stream);
        }
    }
    anyhow::bail!("Host unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    struct Fake {
        calls: Arc<AtomicUsize>,
        answers: Vec<IpAddr>,
    }
    impl Resolver for Fake {
        fn resolve(&self, _: String) -> Resolution {
            let count = self.calls.fetch_add(1, Ordering::SeqCst);
            let answers = if count == 0 {
                self.answers.clone()
            } else {
                vec!["169.254.169.254".parse().unwrap()]
            };
            Box::pin(async move { Ok(answers) })
        }
    }
    #[tokio::test]
    async fn ticket_t_4_stalled_first_address_does_not_hide_reachable_answer() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let completed = tokio::time::timeout(
            Duration::from_millis(200),
            connect_addresses(
                vec![
                    "127.0.0.1:1".parse().unwrap(),
                    "127.0.0.2:1".parse().unwrap(),
                ],
                |address| {
                    let dropped = dropped.clone();
                    async move {
                        if address.ip().to_string() == "127.0.0.1" {
                            struct PendingAttempt(Arc<AtomicUsize>);
                            impl Drop for PendingAttempt {
                                fn drop(&mut self) {
                                    self.0.fetch_add(1, Ordering::SeqCst);
                                }
                            }
                            let _pending = PendingAttempt(dropped);
                            std::future::pending::<()>().await;
                        }
                        // Let the first attempt start before this one succeeds.
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        Ok(address)
                    }
                },
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(completed.ip().to_string(), "127.0.0.2");
        tokio::time::timeout(Duration::from_millis(200), async {
            while dropped.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn ticket_t_4_prohibited_and_mixed_dns_answers() {
        for ip in [
            "0.0.0.0",
            "0.1.2.3",
            "169.254.169.254",
            "169.254.1.1",
            "224.0.0.1",
            "255.255.255.255",
            "100.100.100.200",
            "::",
            "fe80::1",
            "ff02::1",
            "fd00:ec2::254",
            "::ffff:169.254.169.254",
            "2002:a9fe:a9fe::1",
            "64:ff9b::a9fe:a9fe",
            "2001::1",
        ] {
            assert!(!permitted(ip.parse().unwrap()), "{ip}");
            let guard = HttpGuard::new(
                Arc::new(Fake {
                    calls: Arc::default(),
                    answers: vec!["127.0.0.1".parse().unwrap(), ip.parse().unwrap()],
                }),
                Duration::from_secs(1),
                100,
            )
            .unwrap();
            assert!(
                guard
                    .get("http://printer.test:1/", None)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("Prohibited")
            );
        }
        for ip in [
            "127.0.0.1",
            "192.168.1.4",
            "10.0.0.1",
            "::1",
            "fd12::1",
            "2606:4700::1111",
        ] {
            assert!(permitted(ip.parse().unwrap()));
        }
    }
    #[tokio::test]
    async fn ticket_t_4_pins_dns_and_rechecks_next_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let calls = Arc::new(AtomicUsize::new(0));
        let guard = HttpGuard::new(
            Arc::new(Fake {
                calls: calls.clone(),
                answers: vec!["127.0.0.1".parse().unwrap()],
            }),
            Duration::from_secs(1),
            100,
        )
        .unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = [0; 1024];
            let len = socket.read(&mut data).await.unwrap();
            let request = String::from_utf8_lossy(&data[..len]);
            assert!(request.contains("host: printer.test:"));
            assert!(request.starts_with("GET /printer/objects/query"));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                .await
                .unwrap();
        });
        let url = format!("http://printer.test:{port}/printer/objects/query");
        assert_eq!(guard.get(&url, None).await.unwrap().body, b"{}");
        server.await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(guard.get(&url, None).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn ticket_t_4_deadline_and_body_limit_and_no_redirect() {
        for mode in ["stall", "large", "redirect"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut data = [0; 1024];
                let _ = socket.read(&mut data).await;
                match mode {
                    "large" => {
                        let _ = socket
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n123456789")
                            .await;
                    }
                    "redirect" => {
                        let _=socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/\r\nContent-Length: 0\r\n\r\n").await;
                    }
                    _ => {
                        let mut end = [0; 1];
                        assert_eq!(socket.read(&mut end).await.unwrap(), 0);
                    }
                }
            });
            let guard =
                HttpGuard::new(Arc::new(SystemResolver), Duration::from_millis(100), 4).unwrap();
            let result = guard.get(&url, None).await;
            if mode == "redirect" {
                assert_eq!(result.unwrap().status, 302);
            } else {
                assert!(result.is_err());
            }
            tokio::time::timeout(Duration::from_secs(1), server)
                .await
                .unwrap()
                .unwrap();
        }
    }
    #[tokio::test]
    async fn ticket_t_4_dns_deadline_and_url_policy() {
        struct Hung;
        impl Resolver for Hung {
            fn resolve(&self, _: String) -> Resolution {
                Box::pin(std::future::pending())
            }
        }
        let guard = HttpGuard::new(Arc::new(Hung), Duration::from_millis(50), 1024).unwrap();
        let started = tokio::time::Instant::now();
        assert!(guard.get("http://printer.test/", None).await.is_err());
        assert!(started.elapsed() < Duration::from_millis(250));
        for url in [
            "https://printer.test/",
            "http://user:password@printer.test/",
            "ftp://printer.test/",
            "/printer/objects/query",
        ] {
            assert!(guard.get(url, None).await.is_err());
        }
    }
    #[tokio::test]
    async fn ticket_t_4_sleep_does_not_extend_socket_deadline() {
        struct JumpClock(AtomicUsize);
        impl WallClock for JumpClock {
            fn now(&self) -> SystemTime {
                SystemTime::UNIX_EPOCH + Duration::from_secs(self.0.load(Ordering::SeqCst) as u64)
            }
        }
        let clock = Arc::new(JumpClock(AtomicUsize::new(0)));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let mut guard =
            HttpGuard::new(Arc::new(SystemResolver), Duration::from_secs(5), 1024).unwrap();
        guard.clock = clock.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = [0; 1024];
            let _ = socket.read(&mut data).await.unwrap();
            clock.0.store(60, Ordering::SeqCst); // OS sleep advances wall time without Tokio time.
            let mut end = [0; 1];
            assert_eq!(socket.read(&mut end).await.unwrap(), 0);
        });
        let started = tokio::time::Instant::now();
        assert!(guard.get(&url, None).await.is_err());
        assert!(started.elapsed() < Duration::from_millis(250));
        server.await.unwrap();
    }
}
