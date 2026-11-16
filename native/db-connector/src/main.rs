mod connection;
mod diagnostics;
mod discovery;
mod schema;
use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use std::time::Duration;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Redis,
    Mysql,
    Mongo,
    Postgres,
    Mssql,
}
impl Engine {
    pub fn port(self) -> u16 {
        match self {
            Self::Redis => 6379,
            Self::Mysql => 3306,
            Self::Mongo => 27017,
            Self::Postgres => 5432,
            Self::Mssql => 1433,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Redis => "Redis",
            Self::Mysql => "MySQL / MariaDB",
            Self::Mongo => "MongoDB",
            Self::Postgres => "PostgreSQL",
            Self::Mssql => "Microsoft SQL Server",
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Discover,
    Test { connection: connection::Connection },
    Catalog { connection: connection::Connection },
    Diagnose { endpoint: diagnostics::Endpoint },
    Inspect { connection: connection::Connection },
}

fn main() {
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    else {
        println!(
            "{}",
            serde_json::json!({"ok":false,"error":"Native runtime could not start"})
        );
        return;
    };
    runtime.block_on(handle_request());
    // DNS resolution uses blocking OS calls. Do not let a timed-out resolver delay a ready response.
    runtime.shutdown_timeout(Duration::from_millis(100));
}
async fn handle_request() {
    // One request per process: secrets travel only through stdin, never command arguments or files.
    let mut input = String::new();
    let result = if io::stdin().take(65537).read_to_string(&mut input).is_err()
        || input.len() > 65536
    {
        serde_json::json!({ "ok": false, "error": "Invalid connector request" })
    } else {
        match serde_json::from_str::<Request>(&input) {
            Ok(Request::Discover) => {
                match tokio::time::timeout(Duration::from_secs(15), discovery::discover()).await {
                    Ok(result) => serde_json::json!({"ok":true,"result":result}),
                    Err(_) => {
                        serde_json::json!({"ok":false,"error":"Local database discovery timed out"})
                    }
                }
            }
            Ok(Request::Test { connection }) => {
                match tokio::time::timeout(Duration::from_secs(12), connection::test(connection))
                    .await
                {
                    Ok(Ok(result)) => serde_json::json!({"ok":true,"result":result}),
                    Ok(Err(message)) => serde_json::json!({"ok":false,"error":message}),
                    Err(_) => {
                        serde_json::json!({"ok":false,"error":"Database connection timed out"})
                    }
                }
            }
            Ok(Request::Catalog { connection }) => {
                match tokio::time::timeout(Duration::from_secs(12), connection::catalog(connection))
                    .await
                {
                    Ok(Ok(result)) => serde_json::json!({"ok":true,"result":result}),
                    Ok(Err(message)) => serde_json::json!({"ok":false,"error":message}),
                    Err(_) => {
                        serde_json::json!({"ok":false,"error":"Database catalog request timed out"})
                    }
                }
            }
            Ok(Request::Inspect { connection }) => {
                match tokio::time::timeout(Duration::from_secs(12), schema::inspect(connection))
                    .await
                {
                    Ok(Ok(result)) => serde_json::json!({"ok":true,"result":result}),
                    Ok(Err(message)) => serde_json::json!({"ok":false,"error":message}),
                    Err(_) => {
                        serde_json::json!({"ok":false,"error":"Database structure inspection timed out"})
                    }
                }
            }
            Ok(Request::Diagnose { endpoint }) => match diagnostics::diagnose(endpoint).await {
                Ok(result) => serde_json::json!({"ok":true,"result":result}),
                Err(message) => serde_json::json!({"ok":false,"error":message}),
            },
            Err(_) => serde_json::json!({"ok":false,"error":"Invalid connector request"}),
        }
    };
    // Driver errors can contain passwords, URIs and data. Only static sanitized messages leave this process.
    println!("{result}");
}
