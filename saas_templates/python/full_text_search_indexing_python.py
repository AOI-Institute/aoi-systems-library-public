"""
System 6: Full-Text Search & Indexing

A production-quality, self-contained full-text search module for a reusable SaaS library.
Exposes an identical API contract across all supported languages.

Storage: in-memory inverted index (word -> {doc_key: tf}) plus per-document metadata.
Tokenization: whitespace split, lowercase, stop-word removal.
Relevance: exact match > partial match > prefix match, with term-frequency weighting.
Filters: metadata fields checked during query (field:value syntax).
Facets: counts grouped by metadata field.
"""

from __future__ import annotations

import re
import time
import uuid
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Database schema (executable DDL). Embedded for reference / migration use.
# ---------------------------------------------------------------------------
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS search_index (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    document_type   TEXT    NOT NULL,
    document_id     TEXT    NOT NULL,
    content         TEXT    NOT NULL,
    indexed_at      TEXT    NOT NULL,
    metadata        TEXT    NOT NULL,
    UNIQUE (document_type, document_id)
);
CREATE INDEX IF NOT EXISTS idx_search_index_type_id
    ON search_index (document_type, document_id);
"""

# ---------------------------------------------------------------------------
# Stop words (common words removed during tokenization)
# ---------------------------------------------------------------------------
STOP_WORDS = frozenset(
    """
    a an and are as at be but by for from had has have he her his i if in is it
    its me my no nor not of on or our she so that the their them then there these
    they this to was we were what when where which who will with you your
    """.split()
)

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_FILTER_RE = re.compile(r"(\w+):(\S+)")


# ---------------------------------------------------------------------------
# Tokenization
# ---------------------------------------------------------------------------
def tokenize(text: str) -> List[str]:
    """Split on whitespace/punctuation, lowercase, remove stop words."""
    if not text:
        return []
    tokens: List[str] = []
    for raw in text.lower().split():
        for piece in _TOKEN_RE.findall(raw):
            if piece and piece not in STOP_WORDS:
                tokens.append(piece)
    return tokens


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------
@dataclass
class Document:
    document_type: str
    document_id: str
    content: str
    indexed_at: float
    metadata: Dict[str, Any] = field(default_factory=dict)
    tokens: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Search engine
# ---------------------------------------------------------------------------
class SearchEngine:
    """In-memory inverted-index full-text search engine."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        # doc_key -> Document
        self._docs: Dict[str, Document] = {}
        # word -> {doc_key: term_frequency}
        self._index: Dict[str, Dict[str, int]] = {}
        # background reindex jobs
        self._jobs: Dict[str, Dict[str, Any]] = {}

    # -- helpers -----------------------------------------------------------
    @staticmethod
    def _doc_key(document_type: str, document_id: Any) -> str:
        return f"{document_type}:{document_id}"

    def _add_to_index(self, doc: Document) -> None:
        for token in doc.tokens:
            bucket = self._index.setdefault(token, {})
            bucket[doc._key] = bucket.get(doc._key, 0) + 1

    def _remove_from_index(self, doc: Document) -> None:
        for token in set(doc.tokens):
            bucket = self._index.get(token)
            if not bucket:
                continue
            bucket.pop(doc._key, None)
            if not bucket:
                self._index.pop(token, None)

    # -- public API --------------------------------------------------------
    def index_document(
        self,
        document_type: str,
        document_id: Any,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Index (or re-index) a document. Returns {success, indexed_at}."""
        if not document_type:
            raise ValueError("document_type is required")
        if document_id is None:
            raise ValueError("document_id is required")

        metadata = dict(metadata or {})
        indexed_at = time.time()
        doc = Document(
            document_type=document_type,
            document_id=str(document_id),
            content=content or "",
            indexed_at=indexed_at,
            metadata=metadata,
            tokens=tokenize(content or ""),
        )
        doc._key = self._doc_key(document_type, document_id)  # type: ignore[attr-defined]

        with self._lock:
            existing = self._docs.get(doc._key)
            if existing is not None:
                self._remove_from_index(existing)
            self._docs[doc._key] = doc
            self._add_to_index(doc)

        return {"success": True, "indexed_at": indexed_at}

    def unindex_document(self, document_type: str, document_id: Any) -> Dict[str, Any]:
        """Remove a document from the index. Returns {success}."""
        key = self._doc_key(document_type, document_id)
        with self._lock:
            doc = self._docs.pop(key, None)
            if doc is not None:
                self._remove_from_index(doc)
        return {"success": True}

    def search(
        self,
        q: str = "",
        document_type: Optional[str] = None,
        filters: Optional[Dict[str, str]] = None,
        facets: Optional[List[str]] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> Dict[str, Any]:
        """
        Search the index.

        Returns:
            {
              results: [{document_id, document_type, relevance, metadata}],
              total: int,
              has_more: bool,
              facets: {field: {value: count}}  # only when facets requested
            }
        """
        filters = dict(filters or {})
        facets = list(facets or [])

        # Parse any embedded field:value filters from the query string.
        query_tokens, embedded_filters = self._parse_query(q)
        for k, v in embedded_filters.items():
            filters.setdefault(k, v)

        with self._lock:
            # Candidate documents: those matching at least one query token
            # (or all documents if no query tokens).
            if query_tokens:
                candidate_keys: set = set()
                for token in query_tokens:
                    bucket = self._index.get(token)
                    if bucket:
                        candidate_keys.update(bucket.keys())
                    # prefix / partial matches
                    for word, bucket in self._index.items():
                        if word.startswith(token) or token in word:
                            candidate_keys.update(bucket.keys())
            else:
                candidate_keys = set(self._docs.keys())

            scored: List[Tuple[float, Document]] = []
            for key in candidate_keys:
                doc = self._docs.get(key)
                if doc is None:
                    continue
                if document_type is not None and doc.document_type != document_type:
                    continue
                if not self._matches_filters(doc, filters):
                    continue
                score = self._score(doc, query_tokens)
                if query_tokens and score <= 0:
                    continue
                scored.append((score, doc))

            # Sort: relevance desc, then indexed_at desc, then key for stability.
            scored.sort(key=lambda t: (-t[0], -t[1].indexed_at, t[1]._key))  # type: ignore[attr-defined]

            total = len(scored)
            page = scored[offset : offset + limit]

            results = [
                {
                    "document_id": doc.document_id,
                    "document_type": doc.document_type,
                    "relevance": round(score, 4),
                    "metadata": dict(doc.metadata),
                }
                for score, doc in page
            ]

            facet_counts: Dict[str, Dict[str, int]] = {}
            if facets:
                for field_name in facets:
                    counts: Dict[str, int] = {}
                    for _score, doc in scored:
                        value = doc.metadata.get(field_name)
                        if value is None:
                            continue
                        value = str(value)
                        counts[value] = counts.get(value, 0) + 1
                    facet_counts[field_name] = counts

            response: Dict[str, Any] = {
                "results": results,
                "total": total,
                "has_more": (offset + len(page)) < total,
            }
            if facets:
                response["facets"] = facet_counts
            return response

    def reindex_all(
        self,
        document_type: Optional[str] = None,
        source: Optional[Dict[str, List[Dict[str, Any]]]] = None,
    ) -> Dict[str, Any]:
        """
        Re-index all documents (admin/background task).

        `source` maps document_type -> list of raw documents
        ({document_id, content, metadata}). When omitted, the engine simply
        rebuilds its in-memory index from the documents it already holds.

        Returns {success, job_id, status}.
        """
        job_id = str(uuid.uuid4())
        with self._lock:
            self._jobs[job_id] = {
                "document_type": document_type,
                "status": "enqueued",
                "created_at": time.time(),
            }

        # Perform the reindex synchronously (background_jobs system would
        # normally dispatch this; here we complete it inline and mark done).
        self._do_reindex(job_id, document_type, source)
        return {"success": True, "job_id": job_id, "status": "enqueued"}

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    # -- internals ---------------------------------------------------------
    def _do_reindex(
        self,
        job_id: str,
        document_type: Optional[str],
        source: Optional[Dict[str, List[Dict[str, Any]]]],
    ) -> None:
        with self._lock:
            if source is None:
                # Rebuild from existing docs (idempotent).
                existing = list(self._docs.values())
                for doc in existing:
                    self._remove_from_index(doc)
                for doc in existing:
                    self._add_to_index(doc)
            else:
                types = [document_type] if document_type else list(source.keys())
                for dtype in types:
                    for raw in source.get(dtype, []):
                        self.index_document(
                            dtype,
                            raw["document_id"],
                            raw.get("content", ""),
                            raw.get("metadata", {}),
                        )
            job = self._jobs.get(job_id)
            if job is not None:
                job["status"] = "completed"

    @staticmethod
    def _parse_query(q: str) -> Tuple[List[str], Dict[str, str]]:
        """Split a query into free-text tokens and embedded field:value filters."""
        if not q:
            return [], {}
        filters: Dict[str, str] = {}
        tokens: List[str] = []
        for part in q.split():
            m = _FILTER_RE.fullmatch(part)
            if m:
                filters[m.group(1)] = m.group(2)
            else:
                tokens.extend(tokenize(part))
        return tokens, filters

    @staticmethod
    def _matches_filters(doc: Document, filters: Dict[str, str]) -> bool:
        for field_name, expected in filters.items():
            actual = doc.metadata.get(field_name)
            if actual is None:
                return False
            if str(actual).lower() != str(expected).lower():
                return False
        return True

    @staticmethod
    def _score(doc: Document, query_tokens: List[str]) -> float:
        """
        Relevance scoring:
          exact match  -> 3.0 per token
          partial match (token contained in doc token) -> 2.0
          prefix match (doc token starts with query token) -> 1.0
        Weighted by term frequency (log-scaled) and normalized to [0, 1].
        """
        if not query_tokens:
            return 1.0
        doc_tokens = doc.tokens
        doc_token_set = set(doc_tokens)
        tf: Dict[str, int] = {}
        for t in doc_tokens:
            tf[t] = tf.get(t, 0) + 1

        total = 0.0
        for qt in query_tokens:
            best = 0.0
            if qt in doc_token_set:
                best = max(best, 3.0)
            for dt in doc_token_set:
                if best >= 3.0:
                    break
                if qt in dt:
                    best = max(best, 2.0)
                elif dt.startswith(qt):
                    best = max(best, 1.0)
            if best > 0:
                weight = 1.0 + (tf.get(qt, 0) if qt in tf else 0) * 0.1
                total += best * weight

        if total == 0:
            return 0.0
        # Normalize: divide by the max possible for this query length.
        max_possible = 3.0 * len(query_tokens)
        return min(1.0, total / max_possible)


# ---------------------------------------------------------------------------
# Module-level default engine (singleton) for drop-in use.
# ---------------------------------------------------------------------------
_default_engine = SearchEngine()


def get_engine() -> SearchEngine:
    """Return the shared default SearchEngine instance."""
    return _default_engine


# ---------------------------------------------------------------------------
# HTTP-style endpoint handlers (identical contract across languages).
# These wrap the engine and return JSON-shaped dicts.
# ---------------------------------------------------------------------------
def handle_index(payload: Dict[str, Any]) -> Dict[str, Any]:
    """POST /search/index"""
    return _default_engine.index_document(
        document_type=payload.get("document_type"),
        document_id=payload.get("document_id"),
        content=payload.get("content", ""),
        metadata=payload.get("metadata", {}),
    )


def handle_search(params: Dict[str, Any]) -> Dict[str, Any]:
    """
    GET /search
    params: q, document_type, filters (list of 'field:value' or dict),
            facets (comma-separated list or list), limit, offset
    """
    filters: Dict[str, str] = {}
    raw_filters = params.get("filters")
    if isinstance(raw_filters, dict):
        filters = {str(k): str(v) for k, v in raw_filters.items()}
    elif isinstance(raw_filters, (list, tuple)):
        for item in raw_filters:
            if isinstance(item, str) and ":" in item:
                k, v = item.split(":", 1)
                filters[k] = v
    elif isinstance(raw_filters, str) and ":" in raw_filters:
        k, v = raw_filters.split(":", 1)
        filters[k] = v

    facets: List[str] = []
    raw_facets = params.get("facets")
    if isinstance(raw_facets, str):
        facets = [f.strip() for f in raw_facets.split(",") if f.strip()]
    elif isinstance(raw_facets, (list, tuple)):
        facets = [str(f) for f in raw_facets]

    return _default_engine.search(
        q=params.get("q", ""),
        document_type=params.get("document_type"),
        filters=filters,
        facets=facets,
        limit=int(params.get("limit", 20)),
        offset=int(params.get("offset", 0)),
    )


def handle_unindex(document_type: str, document_id: Any) -> Dict[str, Any]:
    """DELETE /search/documents/:document_type/:document_id"""
    return _default_engine.unindex_document(document_type, document_id)


def handle_reindex(payload: Dict[str, Any]) -> Dict[str, Any]:
    """POST /admin/search/reindex"""
    return _default_engine.reindex_all(
        document_type=payload.get("document_type"),
        source=payload.get("source"),
    )


__all__ = [
    "SearchEngine",
    "Document",
    "tokenize",
    "get_engine",
    "handle_index",
    "handle_search",
    "handle_unindex",
    "handle_reindex",
    "SCHEMA_SQL",
    "STOP_WORDS",
]