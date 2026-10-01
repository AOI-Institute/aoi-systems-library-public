package saas.search;

import java.sql.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;

/**
 * Full-Text Search & Indexing system.
 *
 * Provides an inverted-index based search engine with:
 *  - Document indexing (create/update)
 *  - Full-text search with relevance scoring
 *  - Metadata filtering (tier, status, custom fields)
 *  - Faceting (counts per metadata field value)
 *  - Document unindexing (delete)
 *  - Batch reindexing (background job)
 *
 * Storage: In-memory inverted index backed by a ConcurrentHashMap.
 * Tokenization: whitespace split, lowercase, stop-word removal.
 * Relevance: exact match > partial match > prefix match.
 */
public class FullTextSearchIndexing implements AutoCloseable {

    // ─── Configuration ───────────────────────────────────────────────────────

    public static class Config {
        public int defaultLimit = 20;
        public int maxLimit = 100;
        public int maxOffset = 10_000;
        public Set<String> stopWords = new HashSet<>(Arrays.asList(
                "a", "an", "the", "is", "are", "was", "were", "be", "been",
                "being", "have", "has", "had", "do", "does", "did", "will",
                "would", "could", "should", "may", "might", "shall", "can",
                "need", "dare", "to", "of", "in", "for", "on", "with", "at",
                "by", "from", "as", "into", "through", "during", "before",
                "after", "above", "below", "between", "out", "off", "over",
                "under", "again", "further", "then", "once", "here", "there",
                "all", "any", "both", "each", "few", "more", "most", "other",
                "some", "such", "no", "nor", "not", "only", "own", "same",
                "so", "than", "too", "very", "just", "because", "but", "and",
                "or", "if", "while", "about", "up", "down", "it", "its",
                "this", "that", "these", "those", "i", "you", "he", "she",
                "we", "they", "me", "him", "her", "us", "them", "my", "your",
                "his", "our", "their", "what", "which", "who", "whom", "when",
                "where", "why", "how", "am", "is", "are", "was", "were"
        ));
        public int reindexBatchSize = 500;
        public long reindexDelayMs = 10;
    }

    // ─── Data Models ─────────────────────────────────────────────────────────

    public static class Document {
        public String documentType;
        public String documentId;
        public String content;
        public Instant indexedAt;
        public Map<String, Object> metadata;

        public Document(String documentType, String documentId, String content,
                        Instant indexedAt, Map<String, Object> metadata) {
            this.documentType = documentType;
            this.documentId = documentId;
            this.content = content;
            this.indexedAt = indexedAt;
            this.metadata = metadata != null ? new HashMap<>(metadata) : new HashMap<>();
        }
    }

    public static class SearchResult {
        public String documentId;
        public String documentType;
        public double relevance;
        public Map<String, Object> metadata;

        public SearchResult(String documentId, String documentType, double relevance,
                            Map<String, Object> metadata) {
            this.documentId = documentId;
            this.documentType = documentType;
            this.relevance = relevance;
            this.metadata = metadata;
        }
    }

    public static class SearchResponse {
        public List<SearchResult> results;
        public long total;
        public boolean hasMore;
        public Map<String, Map<String, Long>> facets;

        public SearchResponse(List<SearchResult> results, long total, boolean hasMore,
                              Map<String, Map<String, Long>> facets) {
            this.results = results;
            this.total = total;
            this.hasMore = hasMore;
            this.facets = facets;
        }
    }

    public static class IndexResponse {
        public boolean success;
        public Instant indexedAt;

        public IndexResponse(boolean success, Instant indexedAt) {
            this.success = success;
            this.indexedAt = indexedAt;
        }
    }

    public static class DeleteResponse {
        public boolean success;

        public DeleteResponse(boolean success) {
            this.success = success;
        }
    }

    public static class ReindexResponse {
        public boolean success;
        public String jobId;
        public String status;

        public ReindexResponse(boolean success, String jobId, String status) {
            this.success = success;
            this.jobId = jobId;
            this.status = status;
        }
    }

    // ─── Internal Index Structures ───────────────────────────────────────────

    /** Inverted index: token -> set of "type:id" keys */
    private final Map<String, Set<String>> invertedIndex = new ConcurrentHashMap<>();

    /** Document store: "type:id" -> Document */
    private final Map<String, Document> documentStore = new ConcurrentHashMap<>();

    /** Metadata index: field -> value -> set of "type:id" keys */
    private final Map<String, Map<String, Set<String>>> metadataIndex = new ConcurrentHashMap<>();

    private final Config config;
    private final ExecutorService reindexExecutor;
    private final AtomicLong jobIdCounter = new AtomicLong(0);
    private final Map<String, String> jobStatus = new ConcurrentHashMap<>();

    // ─── Constructor ─────────────────────────────────────────────────────────

    public FullTextSearchIndexing() {
        this(new Config());
    }

    public FullTextSearchIndexing(Config config) {
        this.config = config != null ? config : new Config();
        this.reindexExecutor = Executors.newFixedThreadPool(2, r -> {
            Thread t = new Thread(r, "search-reindex-worker");
            t.setDaemon(true);
            return t;
        });
    }

    // ─── Tokenization ────────────────────────────────────────────────────────

    private List<String> tokenize(String text) {
        if (text == null || text.isEmpty()) {
            return Collections.emptyList();
        }
        String lower = text.toLowerCase(Locale.ROOT);
        String[] parts = lower.split("\\s+");
        List<String> tokens = new ArrayList<>();
        for (String part : parts) {
            String trimmed = part.trim();
            if (trimmed.isEmpty()) continue;
            // Remove non-alphanumeric characters from edges
            trimmed = trimmed.replaceAll("^[^a-z0-9]+", "").replaceAll("[^a-z0-9]+$", "");
            if (trimmed.isEmpty()) continue;
            if (config.stopWords.contains(trimmed)) continue;
            tokens.add(trimmed);
        }
        return tokens;
    }

    private String docKey(String documentType, String documentId) {
        return documentType + ":" + documentId;
    }

    // ─── 1. Index Document ───────────────────────────────────────────────────

    /**
     * Index or update a document.
     *
     * @param documentType e.g. "user", "deployment"
     * @param documentId   unique ID within the type
     * @param content      full searchable text
     * @param metadata     filterable fields
     * @return IndexResponse with success and indexedAt
     */
    public IndexResponse indexDocument(String documentType, String documentId,
                                       String content, Map<String, Object> metadata) {
        if (documentType == null || documentType.isEmpty()) {
            throw new IllegalArgumentException("document_type is required");
        }
        if (documentId == null || documentId.isEmpty()) {
            throw new IllegalArgumentException("document_id is required");
        }

        String key = docKey(documentType, documentId);
        Instant now = Instant.now();

        // Remove old index entries if document exists
        removeIndexEntries(key);

        // Store document
        Document doc = new Document(documentType, documentId, content, now, metadata);
        documentStore.put(key, doc);

        // Build inverted index
        List<String> tokens = tokenize(content);
        for (String token : tokens) {
            invertedIndex.computeIfAbsent(token, k -> ConcurrentHashMap.newKeySet()).add(key);
        }

        // Build metadata index
        if (metadata != null) {
            for (Map.Entry<String, Object> entry : metadata.entrySet()) {
                String field = entry.getKey();
                Object value = entry.getValue();
                if (value == null) continue;
                String strValue = value.toString();
                metadataIndex
                        .computeIfAbsent(field, k -> new ConcurrentHashMap<>())
                        .computeIfAbsent(strValue, k -> ConcurrentHashMap.newKeySet())
                        .add(key);
            }
        }

        return new IndexResponse(true, now);
    }

    // ─── 2. Search ───────────────────────────────────────────────────────────

    /**
     * Search documents.
     *
     * @param query          search query (may contain filter syntax like "tier:team")
     * @param documentType   optional filter by document type
     * @param filters        map of metadata field -> value for filtering
     * @param limit          max results (default 20, max 100)
     * @param offset         pagination offset
     * @param facetFields    list of metadata fields to facet on
     * @return SearchResponse
     */
    public SearchResponse search(String query, String documentType,
                                 Map<String, String> filters, int limit, int offset,
                                 List<String> facetFields) {
        if (limit <= 0) limit = config.defaultLimit;
        if (limit > config.maxLimit) limit = config.maxLimit;
        if (offset < 0) offset = 0;
        if (offset > config.maxOffset) offset = config.maxOffset;

        // Parse query: extract filter tokens (field:value) and text tokens
        QueryParts parts = parseQuery(query);

        // Merge explicit filters with query-parsed filters
        Map<String, String> allFilters = new HashMap<>();
        if (filters != null) {
            allFilters.putAll(filters);
        }
        allFilters.putAll(parts.filters);

        // Determine candidate document keys
        Set<String> candidates = null;

        // If there are text tokens, use inverted index
        if (!parts.textTokens.isEmpty()) {
            candidates = new HashSet<>();
            for (String token : parts.textTokens) {
                Set<String> docs = invertedIndex.get(token);
                if (docs != null) {
                    candidates.addAll(docs);
                }
                // Also check prefix matches
                for (Map.Entry<String, Set<String>> entry : invertedIndex.entrySet()) {
                    if (entry.getKey().startsWith(token) && !entry.getKey().equals(token)) {
                        candidates.addAll(entry.getValue());
                    }
                }
            }
        }

        // If no text tokens, all documents are candidates
        if (candidates == null) {
            candidates = new HashSet<>(documentStore.keySet());
        }

        // Apply document type filter
        if (documentType != null && !documentType.isEmpty()) {
            candidates = candidates.stream()
                    .filter(k -> k.startsWith(documentType + ":"))
                    .collect(Collectors.toSet());
        }

        // Apply metadata filters
        for (Map.Entry<String, String> filter : allFilters.entrySet()) {
            String field = filter.getKey();
            String value = filter.getValue();
            Map<String, Set<String>> fieldIndex = metadataIndex.get(field);
            if (fieldIndex == null) {
                candidates.clear();
                break;
            }
            Set<String> matching = fieldIndex.get(value);
            if (matching == null) {
                candidates.clear();
                break;
            }
            candidates.retainAll(matching);
        }

        // Score and sort
        List<ScoredDoc> scored = new ArrayList<>();
        for (String key : candidates) {
            Document doc = documentStore.get(key);
            if (doc == null) continue;
            double score = computeRelevance(doc, parts.textTokens);
            if (score > 0 || parts.textTokens.isEmpty()) {
                scored.add(new ScoredDoc(key, doc, score));
            }
        }

        scored.sort((a, b) -> Double.compare(b.score, a.score));

        long total = scored.size();

        // Pagination
        int fromIndex = Math.min(offset, scored.size());
        int toIndex = Math.min(offset + limit, scored.size());
        List<SearchResult> results = new ArrayList<>();
        for (int i = fromIndex; i < toIndex; i++) {
            ScoredDoc sd = scored.get(i);
            results.add(new SearchResult(
                    sd.doc.documentId,
                    sd.doc.documentType,
                    sd.score,
                    sd.doc.metadata
            ));
        }

        boolean hasMore = (offset + limit) < total;

        // Facets
        Map<String, Map<String, Long>> facets = null;
        if (facetFields != null && !facetFields.isEmpty()) {
            facets = computeFacets(candidates, facetFields);
        }

        return new SearchResponse(results, total, hasMore, facets);
    }

    // Convenience overloads
    public SearchResponse search(String query) {
        return search(query, null, null, config.defaultLimit, 0, null);
    }

    public SearchResponse search(String query, String documentType, int limit, int offset) {
        return search(query, documentType, null, limit, offset, null);
    }

    public SearchResponse search(String query, String documentType,
                                 Map<String, String> filters, int limit, int offset) {
        return search(query, documentType, filters, limit, offset, null);
    }

    public SearchResponse search(String query, String documentType,
                                 Map<String, String> filters, int limit, int offset,
                                 List<String> facetFields) {
        return search(query, documentType, filters, limit, offset, facetFields);
    }

    // ─── 3. Search with Filters (convenience) ────────────────────────────────

    /**
     * Search with explicit filters.
     * Example: search("stripe", "deployment", Map.of("tier","team","status","active"), 20, 0)
     */
    public SearchResponse searchWithFilters(String query, String documentType,
                                            Map<String, String> filters, int limit, int offset) {
        return search(query, documentType, filters, limit, offset, null);
    }

    // ─── 4. Search with Facets (convenience) ─────────────────────────────────

    /**
     * Search with faceting.
     */
    public SearchResponse searchWithFacets(String query, String documentType,
                                           List<String> facetFields, int limit, int offset) {
        return search(query, documentType, null, limit, offset, facetFields);
    }

    // ─── 5. Unindex Document ─────────────────────────────────────────────────

    /**
     * Remove a document from the index.
     */
    public DeleteResponse unindexDocument(String documentType, String documentId) {
        if (documentType == null || documentType.isEmpty()) {
            throw new IllegalArgumentException("document_type is required");
        }
        if (documentId == null || documentId.isEmpty()) {
            throw new IllegalArgumentException("document_id is required");
        }

        String key = docKey(documentType, documentId);
        removeIndexEntries(key);
        documentStore.remove(key);

        return new DeleteResponse(true);
    }

    // ─── 6. Re-index All ─────────────────────────────────────────────────────

    /**
     * Enqueue a background reindex job.
     *
     * @param documentType specific type or null for all
     * @return ReindexResponse with job_id and status
     */
    public ReindexResponse reindexAll(String documentType) {
        String jobId = "reindex-" + jobIdCounter.incrementAndGet();
        jobStatus.put(jobId, "enqueued");

        final String type = documentType;
        reindexExecutor.submit(() -> {
            try {
                jobStatus.put(jobId, "running");
                performReindex(type);
                jobStatus.put(jobId, "completed");
            } catch (Exception e) {
                jobStatus.put(jobId, "failed");
            }
        });

        return new ReindexResponse(true, jobId, "enqueued");
    }

    /**
     * Synchronous reindex (for testing or immediate use).
     */
    public void performReindex(String documentType) {
        // Clear existing index
        invertedIndex.clear();
        documentStore.clear();
        metadataIndex.clear();

        // Rebuild from a snapshot of what would be the source of truth.
        // In a real system, this would query the database.
        // Here we rebuild from a provided source if available.
        // For this implementation, we assume the caller has already
        // re-indexed documents via indexDocument, or we rebuild from
        // a registered source.
        if (reindexSource != null) {
            List<Document> docs = reindexSource.getDocumentType().equals("all")
                    ? reindexSource.getAllDocuments()
                    : reindexSource.getDocumentsByType(documentType);
            for (Document doc : docs) {
                indexDocument(doc.documentType, doc.documentId, doc.content, doc.metadata);
            }
        }
    }

    // ─── Reindex Source Interface ────────────────────────────────────────────

    public interface ReindexSource {
        List<Document> getAllDocuments();
        List<Document> getDocumentsByType(String type);
        String getDocumentType(); // "all" or specific type
    }

    private ReindexSource reindexSource;

    public void setReindexSource(ReindexSource source) {
        this.reindexSource = source;
    }

    // ─── Query Parsing ───────────────────────────────────────────────────────

    private static class QueryParts {
        List<String> textTokens = new ArrayList<>();
        Map<String, String> filters = new HashMap<>();
    }

    private QueryParts parseQuery(String query) {
        QueryParts parts = new QueryParts();
        if (query == null || query.trim().isEmpty()) {
            return parts;
        }

        String[] tokens = query.trim().split("\\s+");
        for (String token : tokens) {
            int colonIdx = token.indexOf(':');
            if (colonIdx > 0) {
                String field = token.substring(0, colonIdx).toLowerCase(Locale.ROOT);
                String value = token.substring(colonIdx + 1).toLowerCase(Locale.ROOT);
                if (!field.isEmpty() && !value.isEmpty()) {
                    parts.filters.put(field, value);
                }
            } else {
                String lower = token.toLowerCase(Locale.ROOT);
                if (!config.stopWords.contains(lower) && !lower.isEmpty()) {
                    parts.textTokens.add(lower);
                }
            }
        }
        return parts;
    }

    // ─── Relevance Scoring ───────────────────────────────────────────────────

    private static class ScoredDoc {
        String key;
        Document doc;
        double score;

        ScoredDoc(String key, Document doc, double score) {
            this.key = key;
            this.doc = doc;
            this.score = score;
        }
    }

    private double computeRelevance(Document doc, List<String> queryTokens) {
        if (queryTokens == null || queryTokens.isEmpty()) {
            return 1.0; // No text query, all equal
        }

        String contentLower = (doc.content != null ? doc.content : "").toLowerCase(Locale.ROOT);
        double totalScore = 0.0;

        for (String qt : queryTokens) {
            double tokenScore = 0.0;

            // Exact match: token appears as a whole word in content
            if (contentLower.contains(qt)) {
                // Check if it's an exact word match
                String[] words = contentLower.split("\\s+");
                boolean exactWordMatch = false;
                for (String w : words) {
                    if (w.equals(qt)) {
                        exactWordMatch = true;
                        break;
                    }
                }
                if (exactWordMatch) {
                    tokenScore = 3.0; // exact match
                } else if (contentLower.contains(qt)) {
                    tokenScore = 2.0; // partial match (substring)
                }
            }

            // Prefix match: any word starts with the query token
            if (tokenScore == 0.0) {
                String[] words = contentLower.split("\\s+");
                for (String w : words) {
                    if (w.startsWith(qt)) {
                        tokenScore = 1.0; // prefix match
                        break;
                    }
                }
            }

            totalScore += tokenScore;
        }

        // Normalize: divide by number of query tokens so multi-word queries
        // don't get unfairly high scores
        double normalized = totalScore / queryTokens.size();

        // Bonus: if all tokens matched exactly, boost
        boolean allExact = true;
        for (String qt : queryTokens) {
            String[] words = contentLower.split("\\s+");
            boolean found = false;
            for (String w : words) {
                if (w.equals(qt)) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                allExact = false;
                break;
            }
        }
        if (allExact && queryTokens.size() > 1) {
            normalized *= 1.5; // multi-word exact bonus
        }

        return normalized;
    }

    // ─── Facets ──────────────────────────────────────────────────────────────

    private Map<String, Map<String, Long>> computeFacets(Set<String> candidateKeys,
                                                         List<String> facetFields) {
        Map<String, Map<String, Long>> facets = new LinkedHashMap<>();

        for (String field : facetFields) {
            Map<String, Long> counts = new LinkedHashMap<>();
            for (String key : candidateKeys) {
                Document doc = documentStore.get(key);
                if (doc == null) continue;
                Object value = doc.metadata.get(field);
                if (value != null) {
                    String strValue = value.toString();
                    counts.merge(strValue, 1L, Long::sum);
                }
            }
            // Sort by count descending
            Map<String, Long> sorted = counts.entrySet().stream()
                    .sorted(Map.Entry.<String, Long>comparingByValue().reversed())
                    .collect(Collectors.toMap(
                            Map.Entry::getKey,
                            Map.Entry::getValue,
                            (a, b) -> a,
                            LinkedHashMap::new
                    ));
            facets.put(field, sorted);
        }

        return facets;
    }

    // ─── Internal: Remove Index Entries ──────────────────────────────────────

    private void removeIndexEntries(String key) {
        // Remove from inverted index
        for (Iterator<Map.Entry<String, Set<String>>> it = invertedIndex.entrySet().iterator();
             it.hasNext(); ) {
            Map.Entry<String, Set<String>> entry = it.next();
            entry.getValue().remove(key);
            if (entry.getValue().isEmpty()) {
                it.remove();
            }
        }

        // Remove from metadata index
        for (Iterator<Map.Entry<String, Map<String, Set<String>>>> it = metadataIndex.entrySet().iterator();
             it.hasNext(); ) {
            Map.Entry<String, Map<String, Set<String>>> entry = it.next();
            for (Iterator<Map.Entry<String, Set<String>>> vit = entry.getValue().entrySet().iterator();
                 vit.hasNext(); ) {
                Map.Entry<String, Set<String>> valueEntry = vit.next();
                valueEntry.getValue().remove(key);
                if (valueEntry.getValue().isEmpty()) {
                    vit.remove();
                }
            }
            if (entry.getValue().isEmpty()) {
                it.remove();
            }
        }
    }

    // ─── Utility ─────────────────────────────────────────────────────────────

    public int getDocumentCount() {
        return documentStore.size();
    }

    public int getDocumentCount(String documentType) {
        return (int) documentStore.keySet().stream()
                .filter(k -> k.startsWith(documentType + ":"))
                .count();
    }

    public String getJobStatus(String jobId) {
        return jobStatus.getOrDefault(jobId, "unknown");
    }

    @Override
    public void close() {
        reindexExecutor.shutdown();
        try {
            if (!reindexExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                reindexExecutor.shutdownNow();
            }
        } catch (InterruptedException e) {
            reindexExecutor.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    // ─── DDL (for reference / migration) ─────────────────────────────────────

    public static final String DDL =
            "CREATE TABLE IF NOT EXISTS search_index (\n" +
            "    id BIGINT AUTO_INCREMENT PRIMARY KEY,\n" +
            "    document_type VARCHAR(100) NOT NULL,\n" +
            "    document_id VARCHAR(255) NOT NULL,\n" +
            "    content TEXT,\n" +
            "    indexed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n" +
            "    metadata JSON,\n" +
            "    UNIQUE KEY uk_doc (document_type, document_id),\n" +
            "    FULLTEXT KEY ft_content (content)\n" +
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;";
}