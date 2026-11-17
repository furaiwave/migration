use crate::{
    connection::{self, Connection},
    Engine,
};
use futures_util::{pin_mut, TryStreamExt};
use mysql_async::prelude::Queryable;
use serde::Serialize;
use std::time::{Duration, Instant};

const MAX_BYTES: usize = 2_000_000;
const MAX_COLUMNS: usize = 512;
const MAX_CELL: usize = 16_384;
const MAX_SETS: usize = 16;
const FAILED: &str = "SQL execution failed. Check the statement and database permissions.";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryError {
    pub message: &'static str,
    pub code: Option<String>,
    pub position: Option<u32>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryColumn {
    pub name: String,
    pub data_type: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<QueryColumn>,
    pub rows: Vec<Vec<Option<String>>>,
    pub affected_rows: Option<String>,
    pub row_count: u64,
    pub truncated: bool,
    pub clipped: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub connector: &'static str,
    pub elapsed_ms: u64,
    pub sets: Vec<ResultSet>,
    pub truncated: bool,
    pub error: Option<QueryError>,
}
struct Collector {
    report: Report,
    current: Option<usize>,
    bytes: usize,
    limit: usize,
}
fn clip(value: &str, limit: usize) -> (String, bool) {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_owned(), end < value.len())
}
impl Collector {
    fn new(limit: usize) -> Self {
        Self {
            report: Report {
                connector: "rust",
                elapsed_ms: 0,
                sets: vec![],
                truncated: false,
                error: None,
            },
            current: None,
            bytes: 0,
            limit,
        }
    }
    fn begin(&mut self, columns: impl IntoIterator<Item = (String, String)>) {
        self.current = None;
        if self.report.sets.len() >= MAX_SETS {
            self.report.truncated = true;
            return;
        }
        let mut clipped = false;
        let columns = columns
            .into_iter()
            .take(MAX_COLUMNS + 1)
            .enumerate()
            .filter_map(|(i, (name, ty))| {
                if i == MAX_COLUMNS {
                    clipped = true;
                    return None;
                }
                let (name, a) = clip(&name, 256);
                let (data_type, b) = clip(&ty, 128);
                clipped |= a || b;
                Some(QueryColumn { name, data_type })
            })
            .collect::<Vec<_>>();
        let size = serde_json::to_vec(&columns).map_or(MAX_BYTES, |v| v.len());
        if self.bytes + size > MAX_BYTES {
            self.report.truncated = true;
            return;
        }
        self.bytes += size;
        self.current = Some(self.report.sets.len());
        self.report.sets.push(ResultSet {
            columns,
            rows: vec![],
            affected_rows: None,
            row_count: 0,
            truncated: false,
            clipped,
        });
    }
    fn wants_row(&mut self) -> bool {
        let Some(index) = self.current else {
            return false;
        };
        let set = &mut self.report.sets[index];
        set.row_count = set.row_count.saturating_add(1);
        if set.rows.len() >= self.limit || self.bytes >= MAX_BYTES {
            set.truncated = true;
            self.report.truncated = true;
            false
        } else {
            true
        }
    }
    fn row(&mut self, row: impl IntoIterator<Item = Option<String>>) {
        let Some(index) = self.current else { return };
        let set = &mut self.report.sets[index];
        let row = row
            .into_iter()
            .take(set.columns.len())
            .map(|value| {
                value.map(|value| {
                    let (value, cut) = clip(&value, MAX_CELL);
                    set.clipped |= cut;
                    value
                })
            })
            .collect::<Vec<_>>();
        let size = serde_json::to_vec(&row).map_or(MAX_BYTES, |v| v.len());
        if self.bytes + size > MAX_BYTES {
            set.truncated = true;
            self.report.truncated = true;
            self.bytes = MAX_BYTES;
            return;
        }
        self.bytes += size;
        set.rows.push(row);
    }
    fn completed(&mut self, count: Option<u64>) {
        if let Some(index) = self.current {
            self.report.sets[index].affected_rows = count.map(|n| n.to_string());
        }
    }
}
fn generic(code: Option<String>) -> QueryError {
    QueryError {
        message: FAILED,
        code,
        position: None,
    }
}
fn pg_error(error: tokio_postgres::Error) -> QueryError {
    let code = error.code().map(|code| code.code().to_owned());
    let position = error.as_db_error().and_then(|e| match e.position() {
        Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p),
        _ => None,
    });
    QueryError {
        message: match code.as_deref() {
            Some("23505") => "Unique constraint violation",
            Some("23503") => "Foreign key constraint violation",
            Some("42601") => "SQL syntax error",
            Some("42501") => "Insufficient database permissions",
            _ => FAILED,
        },
        code,
        position,
    }
}
fn mysql_error(error: mysql_async::Error) -> QueryError {
    let code = match error {
        mysql_async::Error::Server(error) => Some(error.code.to_string()),
        _ => None,
    };
    generic(code)
}
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut value = String::from("0x");
    for byte in bytes.iter().take(MAX_CELL / 2 + 1) {
        let _ = write!(value, "{byte:02x}");
    }
    value
}
fn mysql_value(value: &mysql_async::Value) -> Option<String> {
    match value {
        mysql_async::Value::NULL => None,
        mysql_async::Value::Bytes(bytes) => Some(match std::str::from_utf8(bytes) {
            Ok(text) => clip(text, MAX_CELL + 4).0,
            Err(_) => hex(bytes),
        }),
        _ => Some(value.as_sql(false).trim_matches('\'').to_owned()),
    }
}
fn date_value<'a, T: tiberius::FromSql<'a> + std::fmt::Display>(
    value: &'a tiberius::ColumnData<'static>,
) -> Option<String> {
    T::from_sql(value)
        .ok()
        .flatten()
        .map(|value| value.to_string())
}
fn mssql_value(value: &tiberius::ColumnData<'static>) -> Option<String> {
    use tiberius::ColumnData::*;
    macro_rules! text {
        ($v:expr) => {
            $v.as_ref().map(ToString::to_string)
        };
    }
    match value {
        U8(v) => text!(v),
        I16(v) => text!(v),
        I32(v) => text!(v),
        I64(v) => text!(v),
        F32(v) => text!(v),
        F64(v) => text!(v),
        Bit(v) => text!(v),
        String(v) => v.as_ref().map(|v| clip(v, MAX_CELL + 4).0),
        Guid(v) => text!(v),
        Binary(v) => v.as_ref().map(|v| hex(v)),
        Numeric(v) => text!(v),
        Xml(v) => v.as_ref().map(|v| clip(&v.to_string(), MAX_CELL + 4).0),
        Date(_) => date_value::<chrono::NaiveDate>(value),
        Time(_) => date_value::<chrono::NaiveTime>(value),
        DateTime(_) | SmallDateTime(_) | DateTime2(_) => date_value::<chrono::NaiveDateTime>(value),
        DateTimeOffset(_) => date_value::<chrono::DateTime<chrono::FixedOffset>>(value),
    }
}

async fn postgres(c: &Connection, sql: &str, out: &mut Collector) -> Result<(), QueryError> {
    let (client, task) = connection::postgres(c).await.map_err(|_| generic(None))?;
    let result = async {
        let stream = client.simple_query_raw(sql).await.map_err(pg_error)?;
        pin_mut!(stream);
        let mut described = false;
        while let Some(item) = stream.try_next().await.map_err(pg_error)? {
            match item {
                tokio_postgres::SimpleQueryMessage::RowDescription(columns) => {
                    out.begin(columns.iter().map(|c| (c.name().to_owned(), String::new())));
                    described = true;
                }
                tokio_postgres::SimpleQueryMessage::Row(row) => {
                    if out.wants_row() {
                        out.row((0..row.len()).map(|i| row.get(i).map(str::to_owned)));
                    }
                }
                tokio_postgres::SimpleQueryMessage::CommandComplete(count) => {
                    if !described {
                        out.begin([]);
                    }
                    out.completed(Some(count));
                    described = false;
                }
                _ => {}
            }
        }
        Ok(())
    }
    .await;
    drop(client);
    task.abort();
    result
}
async fn mysql(c: &Connection, sql: &str, out: &mut Collector) -> Result<(), QueryError> {
    let mut client = connection::mysql(c).await.map_err(|_| generic(None))?;
    let result = async {
        let mut results = client.query_iter(sql).await.map_err(mysql_error)?;
        loop {
            out.begin(
                results
                    .columns_ref()
                    .iter()
                    .map(|c| (c.name_str().into_owned(), format!("{:?}", c.column_type()))),
            );
            let affected = results.affected_rows();
            while let Some(row) = results.next().await.map_err(mysql_error)? {
                if out.wants_row() {
                    out.row((0..row.len()).map(|i| row.as_ref(i).and_then(mysql_value)));
                }
            }
            out.completed(Some(affected));
            if results.is_empty() {
                break;
            }
        }
        results.drop_result().await.map_err(mysql_error)?;
        Ok(())
    }
    .await;
    // Drop closes this dedicated connection, including pending transaction state.
    drop(client);
    result
}
async fn mssql(c: &Connection, sql: &str, out: &mut Collector) -> Result<(), QueryError> {
    let mut client = connection::mssql(c).await.map_err(|_| generic(None))?;
    let mut stream = client
        .simple_query(sql)
        .await
        .map_err(|e| generic(e.code().map(|c| c.to_string())))?;
    while let Some(item) = stream
        .try_next()
        .await
        .map_err(|e| generic(e.code().map(|c| c.to_string())))?
    {
        match item {
            tiberius::QueryItem::Metadata(metadata) => {
                out.begin(
                    metadata
                        .columns()
                        .iter()
                        .map(|c| (c.name().to_owned(), format!("{:?}", c.column_type()))),
                );
            }
            tiberius::QueryItem::Row(row) => {
                if out.wants_row() {
                    out.row(row.cells().map(|(_, value)| mssql_value(value)));
                }
            }
        }
    }
    if out.report.sets.is_empty() {
        out.begin([]);
    }
    Ok(())
}
pub async fn execute(c: Connection, sql: String, max_rows: usize) -> Result<Report, &'static str> {
    c.validate()?;
    if !matches!(c.engine, Engine::Mysql | Engine::Postgres | Engine::Mssql) {
        return Err("The SQL editor supports PostgreSQL, MySQL and SQL Server");
    }
    if c.database.trim().is_empty() {
        return Err("Choose a database before running SQL");
    }
    if sql.trim().is_empty() || sql.len() > 196_608 || sql.contains('\0') {
        return Err("SQL must contain between 1 and 196608 bytes");
    }
    if !(1..=5000).contains(&max_rows) {
        return Err("The result row limit must be between 1 and 5000");
    }
    let started = Instant::now();
    let mut out = Collector::new(max_rows);
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        match c.engine {
            Engine::Postgres => postgres(&c, &sql, &mut out).await,
            Engine::Mysql => mysql(&c, &sql, &mut out).await,
            Engine::Mssql => mssql(&c, &sql, &mut out).await,
            _ => unreachable!(),
        }
    })
    .await;
    out.report.error = match result {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(error),
        Err(_) => Some(QueryError {
            message: "SQL execution timed out",
            code: None,
            position: None,
        }),
    };
    out.report.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(out.report)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_preserve_nulls_precision_and_unicode() {
        let mut out = Collector::new(1);
        out.begin([
            ("id".into(), "bigint".into()),
            ("value".into(), "text".into()),
        ]);
        assert!(out.wants_row());
        out.row([Some("9007199254740993".into()), None]);
        assert!(!out.wants_row());
        assert_eq!(
            out.report.sets[0].rows[0][0].as_deref(),
            Some("9007199254740993")
        );
        assert!(out.report.sets[0].rows[0][1].is_none());
        assert!(out.report.truncated);
        let (text, cut) = clip(&format!("{}é", "x".repeat(MAX_CELL - 1)), MAX_CELL);
        assert!(cut);
        assert_eq!(text.len(), MAX_CELL - 1);
    }
    #[test]
    fn bounds_sets_and_cells() {
        let mut out = Collector::new(5000);
        for _ in 0..MAX_SETS + 4 {
            out.begin([("v".into(), "text".into())]);
            if out.wants_row() {
                out.row([Some("x".repeat(MAX_CELL + 100))]);
            }
        }

        assert_eq!(out.report.sets.len(), MAX_SETS);
        assert!(out.report.truncated);
        assert!(out.report.sets[0].clipped);
        assert!(serde_json::to_vec(&out.report).unwrap().len() < MAX_BYTES + 10000);
    }
}
