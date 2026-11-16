use crate::Engine;
use serde::Serialize;
use std::{collections::HashMap, path::Path, time::Duration};
use sysinfo::{ProcessRefreshKind, RefreshKind, System};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    pub engine: Engine,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub source: String,
    pub reachable: bool,
    pub protocol_confirmed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub servers: Vec<Server>,
    pub warnings: Vec<String>,
}
fn server(engine: Engine, port: u16, source: &str, label: String) -> Server {
    Server {
        id: format!("{engine:?}:127.0.0.1:{port}"),
        engine,
        label,
        host: "127.0.0.1".into(),
        port,
        source: source.into(),
        reachable: false,
        protocol_confirmed: false,
    }
}
fn classify(text: &str) -> Option<Engine> {
    let s = text.to_lowercase();
    if s.starts_with("redis") || s.starts_with("valkey") {
        return Some(Engine::Redis);
    }
    if s.contains("mysqld")
        || s.contains("mariadbd")
        || s.starts_with("mysql")
        || s.starts_with("mariadb")
    {
        Some(Engine::Mysql)
    } else if s.contains("postgres") || s.contains("pg_ctl") {
        Some(Engine::Postgres)
    } else if s.contains("mongod") {
        Some(Engine::Mongo)
    } else if s.contains("sqlservr") || s == "mssqlserver" || s.starts_with("mssql$") {
        Some(Engine::Mssql)
    } else {
        None
    }
}
fn process_engine(name: &str) -> Option<Engine> {
    let name = name.to_ascii_lowercase();
    match name.strip_suffix(".exe").unwrap_or(&name) {
        "redis-server" | "valkey-server" => Some(Engine::Redis),
        "mysqld" | "mariadbd" => Some(Engine::Mysql),
        "postgres" | "postmaster" => Some(Engine::Postgres),
        "mongod" => Some(Engine::Mongo),
        "sqlservr" => Some(Engine::Mssql),
        _ => None,
    }
}
fn split_command(text: &str) -> Vec<String> {
    let mut quoted = false;
    let mut token = String::new();
    let mut tokens = vec![];
    for c in text.chars() {
        if c == '"' {
            quoted = !quoted;
        } else if c.is_whitespace() && !quoted {
            if !token.is_empty() {
                tokens.push(std::mem::take(&mut token));
            }
        } else {
            token.push(c);
        }
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    tokens
}
fn argument<'a>(args: &'a [String], names: &[&str]) -> Option<&'a str> {
    // Repeated server options use the last occurrence, including -p5544 / -P3308.
    for (i, arg) in args.iter().enumerate().rev() {
        for name in names {
            if arg == name {
                return args.get(i + 1).map(String::as_str);
            }
            if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
                return Some(value);
            }
            if name.len() == 2 && name.starts_with('-') {
                if let Some(value) = arg.strip_prefix(name).filter(|v| !v.is_empty()) {
                    return Some(value);
                }
            }
        }
    }
    None
}
fn config_port(text: &str, engine: Engine) -> Option<u16> {
    let mut section = String::new();
    let mut port = None;
    let mut mongo_net_indent = None;
    for line in text.trim_start_matches('\u{feff}').lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with(['#', ';']) {
            continue;
        }
        if engine == Engine::Mongo {
            let indent = line.len() - line.trim_start().len();
            if trimmed == "net:" {
                mongo_net_indent = Some(indent);
                continue;
            }
            match mongo_net_indent {
                Some(parent) if indent > parent => {}
                _ => {
                    mongo_net_indent = None;
                    continue;
                }
            }
        }
        if trimmed.starts_with('[') {
            section = trimmed
                .split_once(']')
                .map(|(s, _)| format!("{}]", s.to_ascii_lowercase()))
                .unwrap_or_default();
            continue;
        }
        if engine == Engine::Mysql
            && !section.is_empty()
            && !["[mysqld]", "[server]", "[mariadb]"].contains(&section.as_str())
        {
            continue;
        }
        let (key, value) = trimmed
            .split_once('=')
            .or_else(|| trimmed.split_once(':'))
            .or_else(|| {
                if engine == Engine::Redis {
                    trimmed.split_once(char::is_whitespace)
                } else {
                    None
                }
            })
            .unwrap_or(("", ""));
        if key.trim().eq_ignore_ascii_case("port") {
            port = value
                .split(['#', ';'])
                .next()
                .unwrap_or_default()
                .trim()
                .trim_matches(['\'', '"'])
                .parse::<u16>()
                .ok()
                .filter(|p| *p > 0);
        }
    }
    port
}
fn service_engine(name: &str, image: &str) -> Option<Engine> {
    if image.trim().is_empty() {
        return classify(name);
    }
    let args = split_command(image);
    let executable = args.first()?.rsplit(['\\', '/']).next()?;
    if executable.eq_ignore_ascii_case("pg_ctl.exe") || executable == "pg_ctl" {
        Some(Engine::Postgres)
    } else {
        process_engine(executable)
    }
}
fn port_from_command(text: &str, engine: Engine) -> u16 {
    port_from_args(&split_command(text), engine)
}
fn port_from_args(args: &[String], engine: Engine) -> u16 {
    if let Some(port) = argument(
        args,
        match engine {
            Engine::Postgres => &["--port", "-p"],
            Engine::Mysql => &["--port", "-P"],
            _ => &["--port"],
        },
    )
    .and_then(|p| p.parse::<u16>().ok())
    .filter(|p| *p > 0)
    {
        return port;
    }
    let config = if engine == Engine::Redis {
        args.iter()
            .skip(1)
            .find(|arg| arg.ends_with(".conf"))
            .map(|p| Path::new(p).to_path_buf())
    } else if engine == Engine::Postgres {
        argument(args, &["-D", "--pgdata"]).map(|dir| Path::new(dir).join("postgresql.conf"))
    } else {
        argument(args, &["--defaults-file", "--config", "-f"]).map(|p| Path::new(p).to_path_buf())
    };
    if let Some(path) =
        config.filter(|p| p.is_absolute() && !p.to_string_lossy().starts_with(r"\\"))
    {
        if std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() <= 1024 * 1024) {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Some(port) = config_port(&text, engine) {
                    return port;
                }
            }
        }
    }
    engine.port()
}
// Numeric netstat output is matched by PID to DB server processes, including custom ports.
fn parse_listeners(text: &str) -> HashMap<u32, Vec<u16>> {
    let mut out: HashMap<u32, Vec<u16>> = HashMap::new();
    for line in text.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() != 5 || fields[0] != "TCP" || !fields[2].ends_with(":0") {
            continue;
        }
        if let (Some(port), Ok(pid)) = (
            fields[1]
                .rsplit_once(':')
                .and_then(|(_, p)| p.parse::<u16>().ok()),
            fields[4].parse::<u32>(),
        ) {
            if port > 0 {
                out.entry(pid).or_default().push(port);
            }
        }
    }
    out
}
#[cfg(windows)]
fn windows_services(warnings: &mut Vec<String>) -> Vec<Server> {
    use winreg::{enums::*, RegKey};
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut out = vec![];
    match hklm.open_subkey(r"SYSTEM\CurrentControlSet\Services") {
        Ok(services) => {
            for name in services.enum_keys().filter_map(Result::ok) {
                let Ok(key) = services.open_subkey(&name) else {
                    continue;
                };
                let image: String = key.get_value("ImagePath").unwrap_or_default();
                let Some(engine) = service_engine(&name, &image) else {
                    continue;
                };
                let label = key
                    .get_value::<String, _>("DisplayName")
                    .unwrap_or_else(|_| name.clone());
                out.push(server(
                    engine,
                    port_from_command(&image, engine),
                    "service",
                    label,
                ));
            }
        }
        Err(_) => warnings.push(
            "Windows service registry is unavailable; process and port discovery still runs."
                .into(),
        ),
    }
    for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
        if let Ok(instances) = hklm.open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL",
            KEY_READ | view,
        ) {
            for (name, _) in instances.enum_values().filter_map(Result::ok) {
                let Ok(id) = instances.get_value::<String, _>(&name) else {
                    continue;
                };
                let path = format!(
                    r"SOFTWARE\Microsoft\Microsoft SQL Server\{id}\MSSQLServer\SuperSocketNetLib\Tcp\IPAll"
                );
                let Ok(tcp) = hklm.open_subkey_with_flags(path, KEY_READ | view) else {
                    continue;
                };
                for key in ["TcpPort", "TcpDynamicPorts"] {
                    if let Ok(ports) = tcp.get_value::<String, _>(key) {
                        for port in ports
                            .split(',')
                            .filter_map(|p| p.trim().parse::<u16>().ok())
                            .filter(|p| *p > 0)
                        {
                            out.push(server(
                                Engine::Mssql,
                                port,
                                "registry",
                                format!("SQL Server ({name})"),
                            ));
                        }
                    }
                }
            }
        }
    }
    out
}
fn installed() -> (Vec<Server>, Vec<String>) {
    let mut warnings = vec![];
    #[cfg(windows)]
    let mut found = windows_services(&mut warnings);
    #[cfg(not(windows))]
    let mut found = vec![];
    let mut listeners = HashMap::new();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let executable =
            Path::new(&std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()))
                .join("System32/netstat.exe");
        match std::process::Command::new(executable).args(["-ano","-p","tcp"]).creation_flags(0x08000000).output() {
            Ok(result) if result.status.success()=>listeners=parse_listeners(&String::from_utf8_lossy(&result.stdout)),
            _=>warnings.push("Listening ports by process could not be read; registry/configuration ports are used.".into()),
        }
    }
    let system = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );
    for (pid, process) in system.processes() {
        let name = process.name().to_string_lossy();
        let Some(engine) = process_engine(&name) else {
            continue;
        };
        let args = process
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let ports = listeners
            .get(&pid.as_u32())
            .cloned()
            .unwrap_or_else(|| vec![port_from_args(&args, engine)]);
        for port in ports {
            found.push(server(
                engine,
                port,
                "process",
                format!("{} · PID {}", engine.label(), pid.as_u32()),
            ));
        }
    }
    (found, warnings)
}
async fn probe(host: &str, port: u16, engine: Engine) -> (bool, bool) {
    let Ok(Ok(mut tcp)) =
        tokio::time::timeout(Duration::from_millis(350), TcpStream::connect((host, port))).await
    else {
        return (false, false);
    };
    let handshake = async {
        match engine {
            Engine::Redis => {
                tcp.write_all(b"*1\r\n$4\r\nPING\r\n").await?;
                let mut b = [0; 128];
                let n = tcp.read(&mut b).await?;
                Ok(b[..n].starts_with(b"+PONG\r\n")
                    || b[..n].starts_with(b"-NOAUTH ")
                    || b[..n].starts_with(b"-NOPERM "))
            }
            Engine::Mysql => {
                let mut header = [0; 5];
                tcp.read_exact(&mut header).await?;
                Ok(header[3] == 0 && header[4] == 10)
            }
            Engine::Postgres => {
                tcp.write_all(&[0, 0, 0, 8, 4, 210, 22, 47]).await?;
                let mut b = [0; 1];
                tcp.read_exact(&mut b).await?;
                Ok(matches!(b[0], b'S' | b'N'))
            }
            Engine::Mssql => {
                let payload = [
                    0x12, 1, 0, 26, 0, 0, 1, 0, 0, 0, 11, 0, 6, 1, 0, 17, 0, 1, 255, 0, 0, 0, 0, 0,
                    0, 0,
                ];
                tcp.write_all(&payload).await?;
                let mut h = [0; 8];
                tcp.read_exact(&mut h).await?;
                Ok(h[0] == 4 && u16::from_be_bytes([h[2], h[3]]) >= 8)
            }
            Engine::Mongo => {
                let bson = mongodb::bson::to_vec(&mongodb::bson::doc! {"hello":1,"$db":"admin"})
                    .map_err(std::io::Error::other)?;
                let length = (16 + 5 + bson.len()) as i32;
                let mut message = vec![];
                for number in [length, 1, 0, 2013, 0] {
                    message.extend_from_slice(&number.to_le_bytes());
                }
                message.push(0);
                message.extend_from_slice(&bson);
                tcp.write_all(&message).await?;
                let mut h = [0; 16];
                tcp.read_exact(&mut h).await?;
                let length = i32::from_le_bytes(h[0..4].try_into().unwrap());
                if !(22..=1024 * 1024).contains(&length)
                    || i32::from_le_bytes(h[12..16].try_into().unwrap()) != 2013
                {
                    return Ok(false);
                }
                let mut body = vec![0; length as usize - 16];
                tcp.read_exact(&mut body).await?;
                if body[4] != 0 {
                    return Ok(false);
                }
                let doc: mongodb::bson::Document =
                    mongodb::bson::from_slice(&body[5..]).map_err(std::io::Error::other)?;
                Ok(doc.contains_key("isWritablePrimary") || doc.contains_key("ismaster"))
            }
        }
    };
    let confirmed = matches!(
        tokio::time::timeout(Duration::from_millis(600), handshake).await,
        Ok(Ok::<bool, std::io::Error>(true))
    );
    (true, confirmed)
}
pub async fn discover() -> Discovery {
    let (mut candidates, warnings) = tokio::task::spawn_blocking(installed)
        .await
        .unwrap_or_else(|_| (vec![], vec!["System discovery failed".into()]));
    for engine in [
        Engine::Redis,
        Engine::Mysql,
        Engine::Postgres,
        Engine::Mssql,
        Engine::Mongo,
    ] {
        for port in [
            engine.port(),
            match engine {
                Engine::Redis => 6380,
                Engine::Mysql => 3307,
                Engine::Postgres => 5433,
                Engine::Mongo => 27018,
                Engine::Mssql => 1434,
            },
        ] {
            candidates.push(server(engine, port, "port", engine.label().to_string()));
        }
    }
    let mut deduplicated: HashMap<(Engine, String, u16), Server> = HashMap::new();
    for candidate in candidates {
        for host in ["127.0.0.1", "::1"] {
            let mut endpoint = candidate.clone();
            endpoint.host = host.to_string();
            endpoint.id = format!("{:?}:{}:{}", endpoint.engine, host, endpoint.port);
            deduplicated
                .entry((endpoint.engine, endpoint.host.clone(), endpoint.port))
                .or_insert(endpoint);
        }
    }
    let mut tasks = tokio::task::JoinSet::new();
    for (_, mut candidate) in deduplicated {
        tasks.spawn(async move {
            let (reachable, confirmed) =
                probe(&candidate.host, candidate.port, candidate.engine).await;
            candidate.reachable = reachable;
            candidate.protocol_confirmed = confirmed;
            candidate
        });
    }
    let mut servers = vec![];
    while let Some(result) = tasks.join_next().await {
        if let Ok(candidate) = result {
            if candidate.source != "port" || candidate.protocol_confirmed {
                servers.push(candidate);
            }
        }
    }
    servers.sort_by_key(|s| (!s.protocol_confirmed, !s.reachable, s.label.clone(), s.port));
    Discovery { servers, warnings }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifies_db_servers_and_not_tools() {
        assert_eq!(classify("mysqld.exe"), Some(Engine::Mysql));
        assert_eq!(classify("MSSQL$SQLEXPRESS"), Some(Engine::Mssql));
        assert_eq!(classify("sqlcmd.exe"), None);
        assert_eq!(classify("mongosh.exe"), None);
        assert_eq!(process_engine("mongodump.exe"), None);
        assert_eq!(process_engine("mysql.exe"), None);
        assert_eq!(process_engine("mysqld.exe"), Some(Engine::Mysql));
    }
    #[test]
    fn parses_config_sections_and_comments() {
        assert_eq!(
            config_port(
                "[client]\nport=99\n[mysqld]\nport = 3308 # custom",
                Engine::Mysql
            ),
            Some(3308)
        );
        assert_eq!(
            config_port("#port=1111\nport = 5544", Engine::Postgres),
            Some(5544)
        );
        assert_eq!(
            config_port("net:\n  port: 27019", Engine::Mongo),
            Some(27019)
        );
    }
    #[test]
    fn parses_quoted_config_paths() {
        let args = split_command(
            r#""C:\Program Files\MySQL\mysqld.exe" --defaults-file="C:\Data Files\my.ini""#,
        );
        assert_eq!(
            argument(&args, &["--defaults-file"]),
            Some(r"C:\Data Files\my.ini")
        );
    }
    #[test]
    fn matches_listeners_by_pid() {
        let m=parse_listeners(" TCP 0.0.0.0:5544 0.0.0.0:0 LISTENING 42\n TCP 127.0.0.1:1000 127.0.0.1:5544 ESTABLISHED 7");
        assert_eq!(m.get(&42), Some(&vec![5544]));
        assert!(!m.contains_key(&7));
    }
    #[test]
    fn later_configuration_and_options_override_earlier_values() {
        assert_eq!(
            config_port("port=5432\nport='5544' # override", Engine::Postgres),
            Some(5544)
        );
        assert_eq!(
            config_port(
                "[client]\nport=1\n[MYSQLD] # server\nport=3306\nport=3308",
                Engine::Mysql
            ),
            Some(3308)
        );
        assert_eq!(
            config_port(
                "security:\n  ldap:\n    port: 389\nnet:\n  port: 27019\nsystemLog:\n  port: 100",
                Engine::Mongo
            ),
            Some(27019)
        );
        assert_eq!(
            port_from_command("postgres -p 5432 -p5544", Engine::Postgres),
            5544
        );
        assert_eq!(port_from_command("mysqld -P3308", Engine::Mysql), 3308);
        assert_eq!(port_from_command("mysqld -p12345", Engine::Mysql), 3306);
    }
    #[test]
    fn service_helpers_are_not_database_servers() {
        assert_eq!(
            service_engine(
                "MySQLRouter",
                r#""C:\MySQL\mysqlrouter.exe" --config=C:\router.ini"#
            ),
            None
        );
        assert_eq!(
            service_engine("backup", r#""C:\PostgreSQL\backup.exe""#),
            None
        );
        assert_eq!(
            service_engine("ProductionDB", r#""C:\Database\mysqld.exe""#),
            Some(Engine::Mysql)
        );
        assert_eq!(
            service_engine("PG", r#""C:\PostgreSQL\pg_ctl.exe" runservice"#),
            Some(Engine::Postgres)
        );
    }
    #[tokio::test]
    async fn open_http_port_is_not_a_database() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket
                .write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n")
                .await
                .unwrap();
        });
        assert_eq!(probe("127.0.0.1", port, Engine::Mysql).await, (true, false));
        task.await.unwrap();
    }
}
