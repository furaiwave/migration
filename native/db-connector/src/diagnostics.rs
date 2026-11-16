use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::ErrorKind,
    time::{Duration, Instant},
};
use tokio::{
    net::{lookup_host, TcpStream},
    task::JoinSet,
    time::timeout,
};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}
#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Reachable,
    Refused,
    Timeout,
    Unreachable,
    DnsError,
    DnsTimeout,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub host: String,
    pub port: u16,
    pub status: Status,
    pub elapsed_ms: u64,
    pub resolved_addresses: Vec<String>,
}
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 255
        && !host
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || ['/', '\\', '@', '?', '#'].contains(&c))
}
pub async fn diagnose(endpoint: Endpoint) -> Result<Report, &'static str> {
    let host = endpoint
        .host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    if !valid_host(&host) || endpoint.port == 0 {
        return Err("Invalid diagnostic endpoint");
    }
    let started = Instant::now();
    let make = |status, addresses| Report {
        host: host.clone(),
        port: endpoint.port,
        status,
        elapsed_ms: started.elapsed().as_millis() as u64,
        resolved_addresses: addresses,
    };
    let addresses = match timeout(
        Duration::from_secs(2),
        lookup_host((host.as_str(), endpoint.port)),
    )
    .await
    {
        Err(_) => return Ok(make(Status::DnsTimeout, vec![])),
        Ok(Err(_)) => return Ok(make(Status::DnsError, vec![])),
        Ok(Ok(addresses)) => {
            let mut seen = HashSet::new();
            addresses
                .filter(|a| seen.insert(*a))
                .take(8)
                .collect::<Vec<_>>()
        }
    };
    if addresses.is_empty() {
        return Ok(make(Status::DnsError, vec![]));
    }
    let resolved = addresses
        .iter()
        .map(|a| a.ip().to_string())
        .collect::<Vec<_>>();
    let mut tasks = JoinSet::new();
    for address in addresses {
        tasks.spawn(async move {
            match timeout(Duration::from_secs(3), TcpStream::connect(address)).await {
                Ok(Ok(_)) => Status::Reachable,
                Ok(Err(error)) if error.kind() == ErrorKind::ConnectionRefused => Status::Refused,
                Ok(Err(error)) if error.kind() == ErrorKind::TimedOut => Status::Timeout,
                Ok(Err(_)) => Status::Unreachable,
                Err(_) => Status::Timeout,
            }
        });
    }
    let mut status = Status::Unreachable;
    while let Some(result) = tasks.join_next().await {
        if let Ok(next) = result {
            match next {
                Status::Reachable => {
                    tasks.abort_all();
                    return Ok(make(Status::Reachable, resolved));
                }
                Status::Refused => status = Status::Refused,
                Status::Timeout if status != Status::Refused => status = Status::Timeout,
                _ => {}
            }
        }
    }
    Ok(make(status, resolved))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn reachable_port_needs_no_credentials_or_protocol_writes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let report = diagnose(Endpoint {
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
        })
        .await
        .unwrap();
        assert_eq!(report.status, Status::Reachable);
        assert_eq!(report.resolved_addresses, vec!["127.0.0.1"]);
    }
    #[tokio::test]
    async fn closed_port_has_a_distinct_status() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(
            diagnose(Endpoint {
                host: "127.0.0.1".into(),
                port
            })
            .await
            .unwrap()
            .status,
            Status::Refused
        );
    }
    #[tokio::test]
    async fn invalid_input_is_rejected_before_network_access() {
        assert!(diagnose(Endpoint {
            host: "bad host".into(),
            port: 5432
        })
        .await
        .is_err());
        assert!(diagnose(Endpoint {
            host: "127.0.0.1".into(),
            port: 0
        })
        .await
        .is_err());
    }
}
