use crate::Engine;
use mysql_async::prelude::Queryable;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio_util::compat::TokioAsyncWriteCompatExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    pub engine: Engine,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub encrypt: bool,
    #[serde(default)]
    pub trust_server_certificate: bool,
    #[serde(default)]
    pub uri: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub server_version: String,
    pub databases: Vec<String>,
    pub connector: &'static str,
    pub elapsed_ms: u64,
}
pub(crate) const FAILED: &str =
    "Connection failed. Check the server, database, credentials and TLS settings.";
pub(crate) fn failure<T, E>(r: Result<T, E>) -> Result<T, &'static str> {
    r.map_err(|_| FAILED)
}
impl Connection {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.engine == Engine::Redis {
            let client = redis::Client::open(self.uri.as_str())
                .map_err(|_| "Invalid Redis connection URI")?;
            if self.uri.len() > 8192
                || self
                    .uri
                    .chars()
                    .any(|c| c.is_whitespace() || c.is_control())
                || self.uri.contains(['?', '#'])
                || client.get_connection_info().redis.db > i32::MAX as i64
                || !self.uri.starts_with("redis://") && !self.uri.starts_with("rediss://")
                || client.get_connection_info().redis.db < 0
            {
                return Err("Invalid Redis connection URI");
            }
        } else if self.engine == Engine::Mongo {
            if (!self.uri.starts_with("mongodb://") && !self.uri.starts_with("mongodb+srv://"))
                || self.uri.len() > 8192
            {
                return Err("Invalid MongoDB connection URI");
            }
        } else if self.host.trim().is_empty()
            || self.host.len() > 255
            || self.port == 0
            || self.user.trim().is_empty()
            || self.user.len() > 256
            || self.password.len() > 8192
            || self.database.len() > 128
            || self.host.contains(['\0', '\r', '\n'])
        {
            return Err("Invalid database connection settings");
        }
        if matches!(self.engine, Engine::Postgres | Engine::Mssql)
            && self.database.trim().is_empty()
        {
            return Err("An existing database name is required");
        }
        Ok(())
    }
}
pub async fn test(c: Connection) -> Result<ConnectionInfo, &'static str> {
    let started = Instant::now();
    c.validate()?;
    let (server_version, databases) = match c.engine {
        Engine::Redis => {
            let client = failure(redis::Client::open(c.uri.as_str()))?;
            let database = client.get_connection_info().redis.db.to_string();
            let mut connection = failure(client.get_multiplexed_async_connection().await)?;
            let pong: String = failure(redis::cmd("PING").query_async(&mut connection).await)?;
            if pong != "PONG" {
                return Err(FAILED);
            }
            let info: String = redis::cmd("INFO")
                .arg("server")
                .query_async(&mut connection)
                .await
                .unwrap_or_default();
            let version = info
                .lines()
                .find_map(|line| line.strip_prefix("redis_version:"))
                .unwrap_or("connected")
                .trim()
                .to_string();
            (format!("Redis {version}"), vec![database])
        }
        Engine::Postgres => {
            let (client, task) = postgres(&c).await?;
            let outcome: Result<(String, Vec<String>), &'static str> = async {
                let row = failure(client.query_one("SELECT version()", &[]).await)?;
                let version: String = row.get(0);
                let databases = client.query("SELECT datname FROM pg_database WHERE datallowconn AND has_database_privilege(datname, 'CONNECT') ORDER BY datname", &[]).await
                    .map(|rows| rows.into_iter().map(|row| row.get::<_,String>(0)).collect()).unwrap_or_else(|_| vec![c.database.clone()]);
                Ok((version, databases))
            }.await;
            drop(client);
            task.abort();
            outcome?
        }
        Engine::Mysql => {
            let mut client = mysql(&c).await?;
            let outcome: Result<(String, Vec<String>), &'static str> = async {
                let version: Option<String> =
                    failure(client.query_first("SELECT VERSION()").await)?;
                let databases: Vec<String> =
                    client.query("SHOW DATABASES").await.unwrap_or_else(|_| {
                        if c.database.is_empty() {
                            vec![]
                        } else {
                            vec![c.database.clone()]
                        }
                    });
                Ok((version.unwrap_or_default(), databases))
            }
            .await;
            let _ = client.disconnect().await;
            outcome?
        }
        Engine::Mssql => {
            let mut client = mssql(&c).await?;
            let row = failure(
                failure(
                    client
                        .simple_query("SELECT CAST(@@VERSION AS nvarchar(max)) AS version")
                        .await,
                )?
                .into_row()
                .await,
            )?
            .ok_or(FAILED)?;
            let version = row.get::<&str, _>(0).unwrap_or_default().to_string();
            let databases = match client
                .simple_query(
                    "SELECT name FROM sys.databases WHERE HAS_DBACCESS(name)=1 ORDER BY name",
                )
                .await
            {
                Ok(stream) => stream
                    .into_first_result()
                    .await
                    .map(|rows| {
                        rows.into_iter()
                            .filter_map(|r| r.get::<&str, _>(0).map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_else(|_| vec![c.database.clone()]),
                Err(_) => vec![c.database.clone()],
            };
            (version, databases)
        }
        Engine::Mongo => {
            let (client, db_name) = mongo(&c).await?;
            let outcome: Result<(String, Vec<String>), &'static str> = async {
                // ping requires a real driver connection/authentication, rather than an open TCP port.
                failure(
                    client
                        .database(&db_name)
                        .run_command(mongodb::bson::doc! {"ping":1})
                        .await,
                )?;
                let version = client
                    .database(&db_name)
                    .run_command(mongodb::bson::doc! {"buildInfo":1})
                    .await
                    .ok()
                    .and_then(|d| d.get_str("version").ok().map(str::to_owned))
                    .unwrap_or_else(|| "MongoDB (connected)".to_string());
                let databases = client
                    .list_database_names()
                    .await
                    .unwrap_or_else(|_| vec![db_name]);
                Ok((version, databases))
            }
            .await;
            client.shutdown().await;
            outcome?
        }
    };
    Ok(ConnectionInfo {
        server_version,
        databases: normalized_databases(databases),
        connector: "rust",
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
pub(crate) async fn postgres(
    c: &Connection,
) -> Result<(tokio_postgres::Client, tokio::task::JoinHandle<()>), &'static str> {
    let mut config = tokio_postgres::Config::new();
    config
        .host(&c.host)
        .port(c.port)
        .user(&c.user)
        .password(&c.password)
        .dbname(&c.database)
        .connect_timeout(Duration::from_secs(8));
    config.ssl_mode(if c.encrypt {
        tokio_postgres::config::SslMode::Require
    } else {
        tokio_postgres::config::SslMode::Disable
    });
    let mut tls = native_tls::TlsConnector::builder();
    tls.danger_accept_invalid_certs(c.trust_server_certificate)
        .danger_accept_invalid_hostnames(c.trust_server_certificate);
    let (client, connection) = failure(
        config
            .connect(postgres_native_tls::MakeTlsConnector::new(failure(
                tls.build(),
            )?))
            .await,
    )?;
    let task = tokio::spawn(async move {
        let _ = connection.await;
    });

    Ok((client, task))
}

pub(crate) async fn mysql(c: &Connection) -> Result<mysql_async::Conn, &'static str> {
    let mut options = mysql_async::OptsBuilder::default()
        .ip_or_hostname(&c.host)
        .tcp_port(c.port)
        .user(Some(&c.user))
        .pass(Some(&c.password))
        .prefer_socket(false);
    if !c.database.is_empty() {
        options = options.db_name(Some(&c.database));
    }
    if c.encrypt {
        options = options.ssl_opts(Some(
            mysql_async::SslOpts::default()
                .with_danger_accept_invalid_certs(c.trust_server_certificate)
                .with_danger_skip_domain_validation(c.trust_server_certificate),
        ));
    }
    failure(mysql_async::Conn::new(options).await)
}

pub(crate) async fn mssql(
    c: &Connection,
) -> Result<tiberius::Client<tokio_util::compat::Compat<tokio::net::TcpStream>>, &'static str> {
    let mut config = tiberius::Config::new();
    config.host(&c.host);
    config.port(c.port);
    config.database(&c.database);
    config.authentication(tiberius::AuthMethod::sql_server(&c.user, &c.password));
    config.encryption(if c.encrypt {
        tiberius::EncryptionLevel::Required
    } else {
        tiberius::EncryptionLevel::NotSupported
    });
    if c.trust_server_certificate {
        config.trust_cert();
    }
    let tcp = failure(tokio::net::TcpStream::connect(config.get_addr()).await)?;
    failure(tcp.set_nodelay(true))?;
    failure(tiberius::Client::connect(config, tcp.compat_write()).await)
}

pub(crate) async fn mongo(c: &Connection) -> Result<(mongodb::Client, String), &'static str> {
    let mut options = failure(mongodb::options::ClientOptions::parse(&c.uri).await)?;
    options.server_selection_timeout = Some(Duration::from_secs(8));
    options.connect_timeout = Some(Duration::from_secs(8));
    let db_name = options
        .default_database
        .clone()
        .unwrap_or_else(|| "admin".to_string());
    let client = failure(mongodb::Client::with_options(options))?;

    Ok((client, db_name))
}

fn normalized_databases(mut databases: Vec<String>) -> Vec<String> {
    databases.retain(|name| !name.is_empty());
    databases.sort();
    databases.dedup();
    databases
}
fn catalog_connection(mut connection: Connection) -> Connection {
    if connection.database.trim().is_empty() {
        connection.database = match connection.engine {
            Engine::Postgres => "postgres",
            Engine::Mssql => "master",
            _ => "",
        }
        .to_string();
    }
    connection
}
pub async fn catalog(connection: Connection) -> Result<ConnectionInfo, &'static str> {
    test(catalog_connection(connection)).await
}
#[cfg(test)]
mod tests {
    use super::*;
    fn settings() -> Connection {
        serde_json::from_value(serde_json::json!({"engine":"postgres","host":"localhost","port":5432,"user":"postgres","database":"test"})).unwrap()
    }
    #[test]
    fn validates_connection_without_echoing_password() {
        let mut c = settings();
        c.password = "secret".into();
        c.port = 0;
        assert_eq!(c.validate(), Err("Invalid database connection settings"));
    }
    #[test]
    fn rejects_empty_database_and_unknown_engines() {
        let mut c = settings();
        c.database.clear();
        assert!(c.validate().is_err());
        assert!(
            serde_json::from_value::<Connection>(serde_json::json!({"engine":"oracle"})).is_err()
        );
    }
    #[test]
    fn catalog_uses_bootstrap_databases_without_replacing_an_explicit_database() {
        let mut c = settings();
        c.database.clear();
        assert_eq!(catalog_connection(c).database, "postgres");
        let mut c = settings();
        c.engine = Engine::Mssql;
        c.database.clear();
        assert_eq!(catalog_connection(c).database, "master");
        assert_eq!(catalog_connection(settings()).database, "test");
        assert_eq!(
            normalized_databases(vec!["b".into(), "a".into(), "b".into(), "".into()]),
            vec!["a", "b"]
        );
    }
    #[test]
    fn validates_redis_uri_without_requiring_sql_fields() {
        let mut c = settings();
        c.engine = Engine::Redis;
        c.host.clear();
        c.user.clear();
        c.port = 0;
        c.database.clear();
        for uri in [
            "redis://localhost:6379/0",
            "rediss://user:password@localhost:6380/1",
        ] {
            c.uri = uri.into();
            assert!(c.validate().is_ok());
        }
        for uri in ["https://localhost", "redis://localhost/-1"] {
            c.uri = uri.into();
            assert!(c.validate().is_err());
        }
    }
    #[test]
    fn validates_mongo_uri() {
        let mut c = settings();
        c.engine = Engine::Mongo;
        c.uri = "https://localhost".into();
        assert!(c.validate().is_err());
        c.uri = "mongodb://localhost:27017".into();
        assert!(c.validate().is_ok());
    }
}
