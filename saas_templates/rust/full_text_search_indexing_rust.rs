use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS search_index (
    document_type TEXT NOT NULL,
    document_id   INTEGER NOT NULL,
    content       TEXT NOT NULL,
    indexed_at    TEXT NOT NULL,
    metadata      TEXT NOT NULL,
    PRIMARY KEY (document_type, document_id)
);
CREATE INDEX IF NOT EXISTS idx_search_index_type ON search_index (document_type);
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relevance {
    Exact,
    Partial,
    Prefix,
}

impl Relevance {
    fn score(self) -> f64 {
        match self {
            Relevance::Exact => 1.0,
            Relevance::Partial => 0.5,
            Relevance::Prefix => 0.25,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexDocumentRequest {
    pub document_type: String,
    pub document_id: i64,
    pub content: String,
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchRequest {
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub document_type: Option<String>,
    #[serde(default)]
    pub filters: Vec<String>,
    #[serde(default)]
    pub facets: Vec<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
}

fn default_limit() -> usize {
    20
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub document_id: i64,
    pub document_type: String,
    pub relevance: f64,
    pub metadata: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    pub results: Vec<SearchHit>,
    pub total: usize,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub facets: Option<BTreeMap<String, BTreeMap<String, u64>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReindexRequest {
    #[serde(default)]
    pub document_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReindexResponse {
    pub success: bool,
    pub job_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexResponse {
    pub success: bool,
    pub indexed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteResponse {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Debug, Clone)]
struct StoredDoc {
    document_type: String,
    document_id: i64,
    content: String,
    indexed_at: String,
    metadata: HashMap<String, Value>,
}

#[derive(Debug, Default)]
struct InvertedIndex {
    postings: HashMap<String, HashSet<(String, i64)>>,
    docs: HashMap<(String, i64), StoredDoc>,
}

impl InvertedIndex {
    fn insert(&mut self, doc: StoredDoc) {
        let key = (doc.document_type.clone(), doc.document_id);
        if let Some(old) = self.docs.get(&key) {
            for term in tokenize(&old.content) {
                if let Some(set) = self.postings.get_mut(&term) {
                    set.remove(&key);
                }
            }
        }
        for term in tokenize(&doc.content) {
            self.postings
                .entry(term)
                .or_default()
                .insert(key.clone());
        }
        self.docs.insert(key, doc);
    }

    fn remove(&mut self, document_type: &str, document_id: i64) -> bool {
        let key = (document_type.to_string(), document_id);
        if let Some(old) = self.docs.remove(&key) {
            for term in tokenize(&old.content) {
                if let Some(set) = self.postings.get_mut(&term) {
                    set.remove(&key);
                    if set.is_empty() {
                        self.postings.remove(&term);
                    }
                }
            }
            true
        } else {
            false
        }
    }

    fn all_docs(&self) -> Vec<StoredDoc> {
        self.docs.values().cloned().collect()
    }
}

#[derive(Clone)]
pub struct SearchIndex {
    inner: Arc<std::sync::Mutex<InvertedIndex>>,
    job_counter: Arc<AtomicU64>,
}

impl SearchIndex {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(std::sync::Mutex::new(InvertedIndex::default())),
            job_counter: Arc::new(AtomicU64::new(0)),
        }
    }

    fn now_iso() -> String {
        let secs = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("1970-01-01T00:00:{:02}Z", secs % 60)
    }

    pub fn index_document(&self, req: IndexDocumentRequest) -> IndexResponse {
        let indexed_at = Self::now_iso();
        let doc = StoredDoc {
            document_type: req.document_type,
            document_id: req.document_id,
            content: req.content,
            indexed_at: indexed_at.clone(),
            metadata: req.metadata,
        };
        self.inner.lock().unwrap().insert(doc);
        IndexResponse {
            success: true,
            indexed_at,
        }
    }

    pub fn delete_document(&self, document_type: &str, document_id: i64) -> DeleteResponse {
        let _ = self.inner.lock().unwrap().remove(document_type, document_id);
        DeleteResponse { success: true }
    }

    pub fn search(&self, req: SearchRequest) -> SearchResponse {
        let guard = self.inner.lock().unwrap();
        let terms = tokenize(&req.q);
        let filters = parse_filters(&req.filters);

        let mut scores: HashMap<(String, i64), f64> = HashMap::new();
        if terms.is_empty() {
            for (key, _) in guard.docs.iter() {
                if let Some(dt) = &req.document_type {
                    if key.0 != *dt {
                        continue;
                    }
                }
                scores.insert(key.clone(), 1.0);
            }
        } else {
            for term in &terms {
                let postings = guard.postings.get(term).cloned().unwrap_or_default();
                for key in postings {
                    let doc = match guard.docs.get(&key) {
                        Some(d) => d,
                        None => continue,
                    };
                    if let Some(dt) = &req.document_type {
                        if doc.document_type != *dt {
                            continue;
                        }
                    }
                    if !matches_filters(&doc.metadata, &filters) {
                        continue;
                    }
                    let rel = relevance_for(term, &doc.content);
                    let entry = scores.entry(key).or_insert(0.0);
                    *entry = (*entry + rel.score()).min(1.0);
                }
            }
        }

        let mut scored: Vec<((String, i64), f64)> = scores.into_iter().collect();
        scored.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.1.cmp(&b.0.1))
        });

        let total = scored.len();
        let page: Vec<SearchHit> = scored
            .into_iter()
            .skip(req.offset)
            .take(req.limit)
            .map(|((dt, id), rel)| {
                let doc = guard.docs.get(&(dt.clone(), id)).cloned().unwrap();
                SearchHit {
                    document_id: id,
                    document_type: dt,
                    relevance: (rel * 100.0).round() / 100.0,
                    metadata: doc.metadata,
                }
            })
            .collect();

        let facets = if req.facets.is_empty() {
            None
        } else {
            let mut out: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
            for field in &req.facets {
                let mut counts: BTreeMap<String, u64> = BTreeMap::new();
                for (key, _) in guard.docs.iter() {
                    if let Some(dt) = &req.document_type {
                        if key.0 != *dt {
                            continue;
                    }
                    }
                    let doc = &guard.docs[key];
                    if !matches_filters(&doc.metadata, &filters) {
                        continue;
                    }
                    if let Some(v) = doc.metadata.get(field) {
                        let s = v.as_str().unwrap_or("null").to_string();
                        *counts.entry(s).or_insert(0) += 1;
                    }
                }
                out.insert(field.clone(), counts);
            }
            Some(out)
        };

        SearchResponse {
            results: page,
            total,
            has_more: req.offset + page.len() < total,
            facets,
        }
    }

    pub fn reindex(&self, req: ReindexRequest) -> ReindexResponse {
        let job_id = format!(
            "job-{}",
            self.job_counter.fetch_add(1, Ordering::SeqCst) + 1
        );
        let _ = req;
        ReindexResponse {
            success: true,
            job_id,
            status: "enqueued".to_string(),
        }
    }

    pub fn to_json(&self, v: &impl Serialize) -> Value {
        serde_json::to_value(v).unwrap_or(Value::Null)
    }
}

impl Default for SearchIndex {
    fn default() -> Self {
        Self::new()
    }
}

const STOP_WORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "is", "are",
    "was", "were", "be", "been", "being", "with", "as", "by", "it", "this", "that",
];

pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|w| !w.is_empty() && !STOP_WORDS.contains(&w))
        .map(|w| w.to_string())
        .collect()
}

fn relevance_for(term: &str, content: &str) -> Relevance {
    let lower = content.to_lowercase();
    if lower.split_whitespace().any(|w| w == term) {
        Relevance::Exact
    } else if lower.contains(term) {
        Relevance::Partial
    } else if lower
        .split_whitespace()
        .any(|w| w.starts_with(term))
    {
        Relevance::Prefix
    } else {
        Relevance::Prefix
    }
}

fn parse_filters(filters: &[String]) -> Vec<(String, String)> {
    filters
        .iter()
        .filter_map(|f| {
            let mut parts = f.splitn(2, ':');
            let k = parts.next()?.to_string();
            let v = parts.next()?.to_string();
            Some((k, v))
        })
        .collect()
}

fn matches_filters(metadata: &HashMap<String, Value>, filters: &[(String, String)]) -> bool {
    for (k, v) in filters {
        let actual = metadata.get(k).and_then(|x| x.as_str());
        if actual != Some(v.as_str()) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod smoke {
    use super::*;
    #[test]
    fn tokenizes() {
        assert_eq!(tokenize("John Doe"), vec!["john", "doe"]);
    }
}