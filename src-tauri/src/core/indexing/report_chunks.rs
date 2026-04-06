//! Source report chunk indexing and retrieval.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

use super::db::IndexDb;
use crate::core::{CoreError, CoreResult};

/// A searchable chunk derived from source analysis reports.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReportChunk {
    pub id: String,
    pub asset_id: String,
    pub section_type: String,
    pub section_index: usize,
    pub start_sec: f64,
    pub end_sec: f64,
    pub search_text: String,
    pub metadata_json: serde_json::Value,
}

/// A search result returned from report chunk retrieval.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReportChunkSearchResult {
    pub chunk_id: String,
    pub asset_id: String,
    pub section_type: String,
    pub section_index: usize,
    pub start_sec: f64,
    pub end_sec: f64,
    pub score: f64,
    pub search_text: String,
    pub metadata_json: serde_json::Value,
}

/// Saves all chunks for an asset, replacing any prior indexed chunks.
pub fn save_report_chunks(db: &IndexDb, asset_id: &str, chunks: &[ReportChunk]) -> CoreResult<()> {
    let conn = db.connection();
    conn.execute(
        "DELETE FROM report_chunks_fts WHERE asset_id = ?1",
        params![asset_id],
    )
    .map_err(|e| CoreError::Internal(format!("Failed to clear report chunk FTS rows: {}", e)))?;
    conn.execute(
        "DELETE FROM report_chunks WHERE asset_id = ?1",
        params![asset_id],
    )
    .map_err(|e| CoreError::Internal(format!("Failed to clear report chunks: {}", e)))?;

    for chunk in chunks {
        let metadata_json = serde_json::to_string(&chunk.metadata_json).map_err(|e| {
            CoreError::Internal(format!("Failed to serialize report chunk metadata: {}", e))
        })?;

        conn.execute(
            r#"
            INSERT INTO report_chunks
                (id, asset_id, section_type, section_index, start_sec, end_sec, search_text, metadata_json)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                chunk.id,
                chunk.asset_id,
                chunk.section_type,
                chunk.section_index as i64,
                chunk.start_sec,
                chunk.end_sec,
                chunk.search_text,
                metadata_json,
            ],
        )
        .map_err(|e| CoreError::Internal(format!("Failed to save report chunk: {}", e)))?;

        conn.execute(
            r#"
            INSERT INTO report_chunks_fts (id, asset_id, section_type, search_text)
            VALUES (?1, ?2, ?3, ?4)
            "#,
            params![
                chunk.id,
                chunk.asset_id,
                chunk.section_type,
                chunk.search_text
            ],
        )
        .map_err(|e| CoreError::Internal(format!("Failed to index report chunk FTS row: {}", e)))?;
    }

    Ok(())
}

/// Searches indexed report chunks using FTS5 lexical retrieval.
pub fn search_report_chunks(
    db: &IndexDb,
    query: &str,
    asset_ids: Option<&[String]>,
    sections: Option<&[String]>,
    limit: usize,
) -> CoreResult<Vec<ReportChunkSearchResult>> {
    let fts_query = to_fts_query(query);
    if fts_query.is_empty() {
        return Ok(Vec::new());
    }

    let mut sql = String::from(
        r#"
        SELECT
            c.id,
            c.asset_id,
            c.section_type,
            c.section_index,
            c.start_sec,
            c.end_sec,
            c.search_text,
            c.metadata_json,
            bm25(report_chunks_fts) AS rank
        FROM report_chunks_fts
        JOIN report_chunks c ON c.id = report_chunks_fts.id
        WHERE report_chunks_fts MATCH ?1
        "#,
    );

    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(fts_query)];
    let mut parameter_index = 2;

    if let Some(asset_ids) = asset_ids.filter(|values| !values.is_empty()) {
        sql.push_str(" AND c.asset_id IN (");
        sql.push_str(
            &std::iter::repeat_n("?", asset_ids.len())
                .collect::<Vec<_>>()
                .join(", "),
        );
        sql.push(')');
        for asset_id in asset_ids {
            params.push(Box::new(asset_id.clone()));
            parameter_index += 1;
        }
    }

    if let Some(sections) = sections.filter(|values| !values.is_empty()) {
        sql.push_str(" AND c.section_type IN (");
        sql.push_str(
            &std::iter::repeat_n("?", sections.len())
                .collect::<Vec<_>>()
                .join(", "),
        );
        sql.push(')');
        for section in sections {
            params.push(Box::new(section.clone()));
            parameter_index += 1;
        }
    }

    sql.push_str(&format!(" ORDER BY rank ASC LIMIT ?{}", parameter_index));
    params.push(Box::new(limit.clamp(1, 100) as i64));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params
        .iter()
        .map(|param| param.as_ref() as &dyn rusqlite::types::ToSql)
        .collect();

    let conn = db.connection();
    let mut stmt = conn.prepare(&sql).map_err(|e| {
        CoreError::Internal(format!("Failed to prepare report chunk search: {}", e))
    })?;

    let rows = stmt
        .query_map(&*param_refs, |row| {
            let rank: f64 = row.get(8)?;
            let metadata_json: String = row.get(7)?;
            let metadata_value =
                serde_json::from_str(&metadata_json).unwrap_or(serde_json::Value::Null);

            Ok(ReportChunkSearchResult {
                chunk_id: row.get(0)?,
                asset_id: row.get(1)?,
                section_type: row.get(2)?,
                section_index: row.get::<_, i64>(3)? as usize,
                start_sec: row.get(4)?,
                end_sec: row.get(5)?,
                score: normalize_rank(rank),
                search_text: row.get(6)?,
                metadata_json: metadata_value,
            })
        })
        .map_err(|e| {
            CoreError::Internal(format!("Failed to execute report chunk search: {}", e))
        })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(
            row.map_err(|e| {
                CoreError::Internal(format!("Failed to read report chunk row: {}", e))
            })?,
        );
    }

    Ok(results)
}

/// Lists report chunks for candidate reranking.
pub fn list_report_chunks(
    db: &IndexDb,
    asset_ids: Option<&[String]>,
    sections: Option<&[String]>,
    limit: usize,
) -> CoreResult<Vec<ReportChunk>> {
    let mut sql = String::from(
        r#"
        SELECT id, asset_id, section_type, section_index, start_sec, end_sec, search_text, metadata_json
        FROM report_chunks
        WHERE 1 = 1
        "#,
    );
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(asset_ids) = asset_ids.filter(|values| !values.is_empty()) {
        sql.push_str(" AND asset_id IN (");
        sql.push_str(&vec!["?"; asset_ids.len()].join(", "));
        sql.push(')');
        for asset_id in asset_ids {
            params.push(Box::new(asset_id.clone()));
        }
    }

    if let Some(sections) = sections.filter(|values| !values.is_empty()) {
        sql.push_str(" AND section_type IN (");
        sql.push_str(&vec!["?"; sections.len()].join(", "));
        sql.push(')');
        for section in sections {
            params.push(Box::new(section.clone()));
        }
    }

    sql.push_str(" ORDER BY asset_id, start_sec LIMIT ?");
    params.push(Box::new(limit.clamp(1, 500) as i64));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params
        .iter()
        .map(|param| param.as_ref() as &dyn rusqlite::types::ToSql)
        .collect();

    let conn = db.connection();
    let mut stmt = conn.prepare(&sql).map_err(|e| {
        CoreError::Internal(format!("Failed to prepare report chunk listing: {}", e))
    })?;

    let rows = stmt
        .query_map(&*param_refs, |row| {
            let metadata_json: String = row.get(7)?;
            Ok(ReportChunk {
                id: row.get(0)?,
                asset_id: row.get(1)?,
                section_type: row.get(2)?,
                section_index: row.get::<_, i64>(3)? as usize,
                start_sec: row.get(4)?,
                end_sec: row.get(5)?,
                search_text: row.get(6)?,
                metadata_json: serde_json::from_str(&metadata_json)
                    .unwrap_or(serde_json::Value::Null),
            })
        })
        .map_err(|e| CoreError::Internal(format!("Failed to list report chunks: {}", e)))?;

    let mut chunks = Vec::new();
    for row in rows {
        chunks.push(
            row.map_err(|e| {
                CoreError::Internal(format!("Failed to read report chunk row: {}", e))
            })?,
        );
    }
    Ok(chunks)
}

/// Saves report chunk embeddings for a given model key.
pub fn save_report_chunk_embeddings(
    db: &IndexDb,
    model: &str,
    embeddings: &[(String, Vec<f32>)],
) -> CoreResult<()> {
    let conn = db.connection();

    for (chunk_id, vector) in embeddings {
        conn.execute(
            r#"
            INSERT OR REPLACE INTO embeddings (id, ref_type, ref_id, model, vector)
            VALUES (?1, 'report_chunk', ?2, ?3, ?4)
            "#,
            params![
                format!("report_chunk:{}:{}", model, chunk_id),
                chunk_id,
                model,
                encode_embedding(vector),
            ],
        )
        .map_err(|e| {
            CoreError::Internal(format!("Failed to save report chunk embedding: {}", e))
        })?;
    }

    Ok(())
}

/// Loads report chunk embeddings by chunk id for a given model key.
pub fn load_report_chunk_embeddings(
    db: &IndexDb,
    model: &str,
    chunk_ids: &[String],
) -> CoreResult<HashMap<String, Vec<f32>>> {
    if chunk_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = vec!["?"; chunk_ids.len()].join(", ");
    let sql = format!(
        "SELECT ref_id, vector FROM embeddings WHERE ref_type = 'report_chunk' AND model = ? AND ref_id IN ({})",
        placeholders
    );
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(model.to_string())];
    for chunk_id in chunk_ids {
        params.push(Box::new(chunk_id.clone()));
    }
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params
        .iter()
        .map(|param| param.as_ref() as &dyn rusqlite::types::ToSql)
        .collect();

    let conn = db.connection();
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| CoreError::Internal(format!("Failed to prepare embedding lookup: {}", e)))?;
    let rows = stmt
        .query_map(&*param_refs, |row| {
            let ref_id: String = row.get(0)?;
            let blob: Vec<u8> = row.get(1)?;
            Ok((ref_id, decode_embedding(&blob)))
        })
        .map_err(|e| CoreError::Internal(format!("Failed to query embeddings: {}", e)))?;

    let mut map = HashMap::new();
    for row in rows {
        let (ref_id, vector_result) =
            row.map_err(|e| CoreError::Internal(format!("Failed to read embedding row: {}", e)))?;
        map.insert(ref_id, vector_result?);
    }
    Ok(map)
}

fn encode_embedding(vector: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vector.len() * std::mem::size_of::<f32>());
    for value in vector {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn decode_embedding(bytes: &[u8]) -> CoreResult<Vec<f32>> {
    if bytes.len() % std::mem::size_of::<f32>() != 0 {
        return Err(CoreError::Internal(
            "Stored embedding bytes are not aligned to f32 size".to_string(),
        ));
    }

    Ok(bytes
        .chunks_exact(std::mem::size_of::<f32>())
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

pub fn cosine_similarity(left: &[f32], right: &[f32]) -> f64 {
    if left.is_empty() || right.is_empty() || left.len() != right.len() {
        return 0.0;
    }

    let dot = left
        .iter()
        .zip(right.iter())
        .map(|(l, r)| (*l as f64) * (*r as f64))
        .sum::<f64>();
    let left_norm = left
        .iter()
        .map(|value| (*value as f64).powi(2))
        .sum::<f64>()
        .sqrt();
    let right_norm = right
        .iter()
        .map(|value| (*value as f64).powi(2))
        .sum::<f64>()
        .sqrt();

    if left_norm <= f64::EPSILON || right_norm <= f64::EPSILON {
        return 0.0;
    }

    dot / (left_norm * right_norm)
}

fn normalize_rank(rank: f64) -> f64 {
    let rank = rank.abs();
    1.0 / (1.0 + rank)
}

fn to_fts_query(query: &str) -> String {
    query
        .to_lowercase()
        .split(|ch: char| !ch.is_alphanumeric())
        .map(str::trim)
        .filter(|token| token.len() >= 2)
        .map(|token| format!("{}*", token))
        .collect::<Vec<_>>()
        .join(" OR ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_and_search_report_chunks() {
        let db = IndexDb::in_memory().unwrap();
        let chunks = vec![
            ReportChunk {
                id: "chunk-1".to_string(),
                asset_id: "asset-1".to_string(),
                section_type: "speakerTurns".to_string(),
                section_index: 0,
                start_sec: 0.0,
                end_sec: 3.0,
                search_text: "best answer quote spoken content".to_string(),
                metadata_json: serde_json::json!({ "preview": "Best answer quote" }),
            },
            ReportChunk {
                id: "chunk-2".to_string(),
                asset_id: "asset-2".to_string(),
                section_type: "moments".to_string(),
                section_index: 0,
                start_sec: 5.0,
                end_sec: 7.0,
                search_text: "crowd reaction visual moment".to_string(),
                metadata_json: serde_json::json!({ "preview": "Crowd reaction" }),
            },
        ];

        save_report_chunks(&db, "asset-1", &chunks[..1]).unwrap();
        save_report_chunks(&db, "asset-2", &chunks[1..]).unwrap();

        let results = search_report_chunks(&db, "answer quote", None, None, 10).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].asset_id, "asset-1");
        assert_eq!(results[0].section_type, "speakerTurns");
        assert!(results[0].score > 0.0);
    }

    #[test]
    fn should_filter_report_chunk_search_by_asset_and_section() {
        let db = IndexDb::in_memory().unwrap();
        save_report_chunks(
            &db,
            "asset-1",
            &[ReportChunk {
                id: "chunk-1".to_string(),
                asset_id: "asset-1".to_string(),
                section_type: "speakerTurns".to_string(),
                section_index: 0,
                start_sec: 0.0,
                end_sec: 3.0,
                search_text: "interviewer question answer".to_string(),
                metadata_json: serde_json::Value::Null,
            }],
        )
        .unwrap();
        save_report_chunks(
            &db,
            "asset-2",
            &[ReportChunk {
                id: "chunk-2".to_string(),
                asset_id: "asset-2".to_string(),
                section_type: "moments".to_string(),
                section_index: 0,
                start_sec: 1.0,
                end_sec: 2.0,
                search_text: "interviewer question answer".to_string(),
                metadata_json: serde_json::Value::Null,
            }],
        )
        .unwrap();

        let results = search_report_chunks(
            &db,
            "question",
            Some(&["asset-1".to_string()]),
            Some(&["speakerTurns".to_string()]),
            10,
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].asset_id, "asset-1");
        assert_eq!(results[0].section_type, "speakerTurns");
    }
}
