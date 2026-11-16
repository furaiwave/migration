use crate::{
    connection::{self, Connection},
    Engine,
};
use mysql_async::prelude::Queryable;
use serde::Serialize;
use std::{collections::BTreeMap, time::Instant};
const MAX_OBJECTS: usize = 200;
const MAX_ROWS: usize = 2000;
const MAX_BYTES: usize = 768_000;
const QUERY_FAILED: &str = "Could not read database structure. Check metadata permissions.";
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub ordinal: u32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Object {
    pub schema: String,
    pub name: String,
    pub kind: String,
    pub columns: Vec<Column>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Schema {
    pub engine: Engine,
    pub database: String,
    pub objects: Vec<Object>,
    pub truncated: bool,
    pub elapsed_ms: u64,
}
struct MetadataRow {
    schema: String,
    name: String,
    kind: String,
    column: Option<Column>,
}
fn collect(rows: Vec<MetadataRow>) -> (Vec<Object>, bool) {
    let mut objects: BTreeMap<(String, String), Object> = BTreeMap::new();
    let mut truncated = false;
    for (index, row) in rows.into_iter().enumerate() {
        if index >= MAX_ROWS {
            truncated = true;
            break;
        }
        let key = (row.schema.clone(), row.name.clone());
        if !objects.contains_key(&key) && objects.len() >= MAX_OBJECTS {
            truncated = true;
            break;
        }
        let object = objects.entry(key).or_insert_with(|| Object {
            schema: row.schema,
            name: row.name,
            kind: row.kind,
            columns: vec![],
        });
        if let Some(column) = row.column {
            object.columns.push(column);
        }
    }
    let mut objects = objects.into_values().collect::<Vec<_>>();
    for object in &mut objects {
        object.columns.sort_by_key(|c| c.ordinal);
    }
    // Metadata can contain large user-defined type names. Bound the final response, not just row count.
    while serde_json::to_vec(&objects).map_or(true, |json| json.len() > MAX_BYTES) {
        truncated = true;
        if objects.pop().is_none() {
            break;
        }
    }
    (objects, truncated)
}
fn column(
    name: Option<String>,
    data_type: Option<String>,
    nullable: Option<String>,
    ordinal: u32,
) -> Option<Column> {
    name.map(|name| Column {
        name,
        data_type: data_type.unwrap_or_default(),
        nullable: nullable.as_deref() == Some("YES"),
        ordinal,
    })
}
const PG_SQL:&str="SELECT t.table_schema,t.table_name,t.table_type,c.column_name,c.data_type,c.is_nullable,COALESCE(c.ordinal_position,0)::int FROM information_schema.tables t LEFT JOIN information_schema.columns c ON c.table_catalog=t.table_catalog AND c.table_schema=t.table_schema AND c.table_name=t.table_name WHERE t.table_schema NOT IN ('pg_catalog','information_schema') AND t.table_type IN ('BASE TABLE','VIEW') ORDER BY t.table_schema,t.table_name,c.ordinal_position LIMIT 2001";
const MYSQL_SQL:&str="SELECT t.TABLE_SCHEMA,t.TABLE_NAME,t.TABLE_TYPE,c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE,COALESCE(c.ORDINAL_POSITION,0) FROM information_schema.TABLES t LEFT JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA=t.TABLE_SCHEMA AND c.TABLE_NAME=t.TABLE_NAME WHERE t.TABLE_SCHEMA=? AND t.TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY t.TABLE_SCHEMA,t.TABLE_NAME,c.ORDINAL_POSITION LIMIT 2001";
const MSSQL_SQL:&str="SELECT TOP (2001) s.name,o.name,CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'BASE TABLE' END,c.name,ty.name,CASE c.is_nullable WHEN 1 THEN 'YES' ELSE 'NO' END,COALESCE(c.column_id,0) FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id LEFT JOIN sys.columns c ON c.object_id=o.object_id LEFT JOIN sys.types ty ON ty.user_type_id=c.user_type_id WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 ORDER BY s.name,o.name,c.column_id";
fn sql_kind(value: &str) -> String {
    if value == "VIEW" { "view" } else { "table" }.into()
}
pub async fn inspect(c: Connection) -> Result<Schema, &'static str> {
    let started = Instant::now();
    c.validate()?;
    if c.engine != Engine::Mongo && c.database.trim().is_empty() {
        return Err("Choose a database before inspecting its structure");
    }
    let mut database = c.database.clone();
    let rows = match c.engine {
        Engine::Redis => {
            return Err("Redis stores keys, not SQL tables; structure inspection is not supported")
        }
        Engine::Postgres => {
            let (client, task) = connection::postgres(&c).await?;
            let result = client
                .query(PG_SQL, &[])
                .await
                .map_err(|_| QUERY_FAILED)
                .and_then(|rows| {
                    rows.into_iter()
                        .map(|r| {
                            Ok(MetadataRow {
                                schema: r.try_get(0).map_err(|_| QUERY_FAILED)?,
                                name: r.try_get(1).map_err(|_| QUERY_FAILED)?,
                                kind: sql_kind(r.try_get::<_, &str>(2).map_err(|_| QUERY_FAILED)?),
                                column: column(
                                    r.try_get(3).map_err(|_| QUERY_FAILED)?,
                                    r.try_get(4).map_err(|_| QUERY_FAILED)?,
                                    r.try_get(5).map_err(|_| QUERY_FAILED)?,
                                    r.try_get::<_, i32>(6).map_err(|_| QUERY_FAILED)? as u32,
                                ),
                            })
                        })
                        .collect::<Result<Vec<_>, &'static str>>()
                });
            drop(client);
            task.abort();
            result?
        }
        Engine::Mysql => {
            let mut client = connection::mysql(&c).await?;
            type Row = (
                String,
                String,
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                u32,
            );
            let result: Result<Vec<Row>, _> = client.exec(MYSQL_SQL, (&c.database,)).await;
            let _ = client.disconnect().await;
            result
                .map_err(|_| QUERY_FAILED)?
                .into_iter()
                .map(|(schema, name, kind, col, ty, null, ordinal)| MetadataRow {
                    schema,
                    name,
                    kind: sql_kind(&kind),
                    column: column(col, ty, null, ordinal),
                })
                .collect()
        }
        Engine::Mssql => {
            let mut client = connection::mssql(&c).await?;
            let result = client
                .simple_query(MSSQL_SQL)
                .await
                .map_err(|_| QUERY_FAILED)?
                .into_first_result()
                .await
                .map_err(|_| QUERY_FAILED)?;
            result
                .into_iter()
                .map(|r| MetadataRow {
                    schema: r.get::<&str, _>(0).unwrap_or_default().into(),
                    name: r.get::<&str, _>(1).unwrap_or_default().into(),
                    kind: sql_kind(r.get::<&str, _>(2).unwrap_or_default()),
                    column: column(
                        r.get::<&str, _>(3).map(str::to_owned),
                        r.get::<&str, _>(4).map(str::to_owned),
                        r.get::<&str, _>(5).map(str::to_owned),
                        r.get::<i32, _>(6).unwrap_or_default() as u32,
                    ),
                })
                .collect()
        }
        Engine::Mongo => {
            let (client, default) = connection::mongo(&c).await?;
            if database.is_empty() {
                database = default;
            }
            let result = async {
                let mut cursor = client
                    .database(&database)
                    .list_collections()
                    .await
                    .map_err(|_| QUERY_FAILED)?;
                let mut rows = vec![];
                while cursor.advance().await.map_err(|_| QUERY_FAILED)? {
                    let spec = cursor.deserialize_current().map_err(|_| QUERY_FAILED)?;
                    let kind =
                        if matches!(spec.collection_type, mongodb::results::CollectionType::View) {
                            "view"
                        } else {
                            "collection"
                        };
                    rows.push(MetadataRow {
                        schema: database.clone(),
                        name: spec.name,
                        kind: kind.into(),
                        column: None,
                    });
                    if rows.len() > MAX_OBJECTS {
                        break;
                    }
                }
                Ok::<_, &'static str>(rows)
            }
            .await;
            client.shutdown().await;
            result?
        }
    };
    let (objects, truncated) = collect(rows);
    Ok(Schema {
        engine: c.engine,
        database,
        objects,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn row(schema: &str, name: &str, ordinal: u32) -> MetadataRow {
        MetadataRow {
            schema: schema.into(),
            name: name.into(),
            kind: "table".into(),
            column: Some(Column {
                name: format!("c{ordinal}"),
                data_type: "integer".into(),
                nullable: true,
                ordinal,
            }),
        }
    }
    #[test]
    fn groups_by_schema_and_name_and_orders_columns() {
        let (objects, truncated) = collect(vec![
            row("a", "same", 2),
            row("b", "same", 1),
            row("a", "same", 1),
        ]);
        assert!(!truncated);
        assert_eq!(objects.len(), 2);
        assert_eq!(objects[0].columns[0].ordinal, 1);
        assert_eq!(objects[1].schema, "b");
    }
    #[test]
    fn reports_object_and_column_limits() {
        let rows = (0..201)
            .map(|n| row("public", &format!("t{n}"), 1))
            .collect();
        let (objects, truncated) = collect(rows);
        assert!(truncated);
        assert_eq!(objects.len(), 200);
        let (rows, truncated) = collect((1..=2001).map(|n| row("public", "wide", n)).collect());
        assert!(truncated);
        assert_eq!(rows[0].columns.len(), 2000);
    }
    #[test]
    fn preserves_objects_with_no_columns_and_bounds_payload_size() {
        let mut huge = row("a", "huge", 1);
        huge.column.as_mut().unwrap().data_type = "x".repeat(MAX_BYTES + 1);
        let (objects, truncated) = collect(vec![huge]);
        assert!(truncated);
        assert!(objects.is_empty());
        let (objects, truncated) = collect(vec![MetadataRow {
            schema: "db".into(),
            name: "empty".into(),
            kind: "collection".into(),
            column: None,
        }]);
        assert!(!truncated);
        assert!(objects[0].columns.is_empty());
    }
    #[tokio::test]
    async fn refuses_a_missing_database_before_connecting() {
        let c = serde_json::from_value(
            serde_json::json!({"engine":"mysql","host":"localhost","port":3306,"user":"test"}),
        )
        .unwrap();
        assert!(inspect(c).await.is_err());
    }
}
