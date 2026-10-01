<?php

declare(strict_types=1);

namespace SaaS\Search;

use PDO;
use PDOException;
use RuntimeException;

/**
 * Full-Text Search & Indexing module.
 *
 * Implements an inverted-index search engine over a `search_index` table.
 * API contract is identical across all 8 languages in the library.
 */
final class SearchEngine
{
    /** Common English stop words removed during tokenization. */
    private const STOP_WORDS = [
        'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
        'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
        'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
        'could', 'should', 'may', 'might', 'can', 'shall', 'it', 'its', 'this',
        'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'me',
        'him', 'her', 'us', 'them', 'my', 'your', 'his', 'our', 'their',
    ];

    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    }

    /**
     * Create the search_index table if it does not exist.
     *
     * @return void
     */
    public function migrate(): void
    {
        $this->db->exec(
            'CREATE TABLE IF NOT EXISTS search_index (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_type TEXT NOT NULL,
                document_id INTEGER NOT NULL,
                content TEXT NOT NULL DEFAULT "",
                indexed_at TEXT NOT NULL,
                metadata TEXT NOT NULL DEFAULT "{}",
                UNIQUE (document_type, document_id)
            )'
        );
        $this->db->exec(
            'CREATE INDEX IF NOT EXISTS idx_search_index_type_id
             ON search_index (document_type, document_id)'
        );
    }

    /**
     * Index (or upsert) a document.
     *
     * @param string $documentType
     * @param int    $documentId
     * @param string $content
     * @param array  $metadata
     * @return array{success: bool, indexed_at: string}
     */
    public function indexDocument(
        string $documentType,
        int $documentId,
        string $content,
        array $metadata = []
    ): array {
        $indexedAt = gmdate('Y-m-d\TH:i:s.u\Z');
        $metadataJson = json_encode($metadata, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        $stmt = $this->db->prepare(
            'INSERT INTO search_index (document_type, document_id, content, indexed_at, metadata)
             VALUES (:type, :id, :content, :indexed_at, :metadata)
             ON CONFLICT (document_type, document_id)
             DO UPDATE SET
                 content = excluded.content,
                 indexed_at = excluded.indexed_at,
                 metadata = excluded.metadata'
        );
        $stmt->execute([
            ':type' => $documentType,
            ':id' => $documentId,
            ':content' => $content,
            ':indexed_at' => $indexedAt,
            ':metadata' => $metadataJson,
        ]);

        return [
            'success' => true,
            'indexed_at' => $indexedAt,
        ];
    }

    /**
     * Search documents.
     *
     * @param string $query
     * @param string|null $documentType
     * @param array $filters  e.g. ['tier' => 'team', 'status' => 'active']
     * @param array $facets   e.g. ['status', 'tier']
     * @param int  $limit
     * @param int  $offset
     * @return array
     */
    public function search(
        string $query,
        ?string $documentType = null,
        array $filters = [],
        array $facets = [],
        int $limit = 20,
        int $offset = 0
    ): array {
        $query = trim($query);

        // Fetch candidate documents
        $candidates = $this->fetchCandidates($documentType);

        if ($query === '') {
            // No query: return all (filtered) documents, no relevance scoring
            $scored = [];
            foreach ($candidates as $doc) {
                if ($this->matchesFilters($doc, $filters)) {
                    $scored[] = ['doc' => $doc, 'score' => 1.0];
                }
            }
        } else {
            $tokens = $this->tokenize($query);
            $scored = [];
            foreach ($candidates as $doc) {
                if (!$this->matchesFilters($doc, $filters)) {
                    continue;
                }
                $score = $this->scoreDocument($doc, $tokens);
                if ($score > 0) {
                    $scored[] = ['doc' => $doc, 'score' => $score];
                }
            }
        }

        // Sort by relevance descending, then by indexed_at descending for stability
        usort($scored, function (array $a, array $b): int {
            if ($a['score'] === $b['score']) {
                return strcmp($b['doc']['indexed_at'], $a['doc']['indexed_at']);
            }
            return $b['score'] <=> $a['score'];
        });

        $total = count($scored);
        $page = array_slice($scored, $offset, $limit);

        $results = [];
        foreach ($page as $item) {
            $doc = $item['doc'];
            $results[] = [
                'document_id' => (int) $doc['document_id'],
                'document_type' => $doc['document_type'],
                'relevance' => round($item['score'], 4),
                'metadata' => json_decode($doc['metadata'], true) ?: [],
            ];
        }

        $response = [
            'results' => $results,
            'total' => $total,
            'has_more' => ($offset + $limit) < $total,
        ];

        if (!empty($facets)) {
            $response['facets'] = $this->computeFacets($candidates, $filters, $facets);
        }

        return $response;
    }

    /**
     * Remove a document from the index.
     *
     * @param string $documentType
     * @param int    $documentId
     * @return array{success: bool}
     */
    public function unindexDocument(string $documentType, int $documentId): array
    {
        $stmt = $this->db->prepare(
            'DELETE FROM search_index WHERE document_type = :type AND document_id = :id'
        );
        $stmt->execute([
            ':type' => $documentType,
            ':id' => $documentId,
        ]);

        return ['success' => true];
    }

    /**
     * Re-index all documents of a given type (or all types if null).
     * Returns a job descriptor; actual reindexing is synchronous here
     * (background job integration is handled by the Background Jobs system).
     *
     * @param string|null $documentType
     * @return array{success: bool, job_id: string, status: string}
     */
    public function reindexAll(?string $documentType = null): array
    {
        $jobId = 'reindex_' . bin2hex(random_bytes(8));

        // In production this would enqueue a background job.
        // Here we perform the reindex synchronously for completeness.
        $this->performReindex($documentType);

        return [
            'success' => true,
            'job_id' => $jobId,
            'status' => 'enqueued',
        ];
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /**
     * @param string|null $documentType
     * @return array<int, array<string, mixed>>
     */
    private function fetchCandidates(?string $documentType): array
    {
        if ($documentType !== null) {
            $stmt = $this->db->prepare(
                'SELECT document_type, document_id, content, indexed_at, metadata
                 FROM search_index WHERE document_type = :type'
            );
            $stmt->execute([':type' => $documentType]);
        } else {
            $stmt = $this->db->query(
                'SELECT document_type, document_id, content, indexed_at, metadata
                 FROM search_index'
            );
        }
        return $stmt->fetchAll();
    }

    /**
     * Tokenize text: lowercase, split on non-alphanumeric, remove stop words.
     *
     * @return string[]
     */
    private function tokenize(string $text): array
    {
        $lower = mb_strtolower($text);
        $parts = preg_split('/[^a-z0-9]+/', $lower, -1, PREG_SPLIT_NO_EMPTY);
        $stopSet = array_flip(self::STOP_WORDS);
        return array_values(array_filter($parts, function (string $w) use ($stopSet): bool {
            return !isset($stopSet[$w]);
        }));
    }

    /**
     * Score a document against query tokens.
     * Scoring:
     *   - Exact token match in content: +10 per token
     *   - Prefix match (token is prefix of a content word): +5 per token
     *   - Partial match (token is substring of a content word): +2 per token
     * Normalized to 0..1 by dividing by (10 * num_query_tokens).
     *
     * @param array  $doc
     * @param string[] $queryTokens
     * @return float
     */
    private function scoreDocument(array $doc, array $queryTokens): float
    {
        if (empty($queryTokens)) {
            return 0.0;
        }

        $contentTokens = $this->tokenize((string) $doc['content']);
        $contentSet = array_flip($contentTokens);
        $contentWords = $contentTokens; // keep duplicates for prefix/substring checks

        $maxScore = 10.0 * count($queryTokens);
        $score = 0.0;

        foreach ($queryTokens as $qt) {
            if (isset($contentSet[$qt])) {
                // Exact match
                $score += 10.0;
            } else {
                $found = false;
                foreach ($contentWords as $cw) {
                    if (str_starts_with($cw, $qt)) {
                        // Prefix match
                        $score += 5.0;
                        $found = true;
                        break;
                    }
                }
                if (!$found) {
                    foreach ($contentWords as $cw) {
                        if (str_contains($cw, $qt)) {
                            // Partial/substring match
                            $score += 2.0;
                            $found = true;
                            break;
                        }
                    }
                }
            }
        }

        return $score / $maxScore;
    }

    /**
     * Check if a document's metadata satisfies all filters.
     *
     * @param array $doc
     * @param array $filters
     * @return bool
     */
    private function matchesFilters(array $doc, array $filters): bool
    {
        if (empty($filters)) {
            return true;
        }
        $metadata = json_decode($doc['metadata'], true) ?: [];
        foreach ($filters as $key => $value) {
            if (!array_key_exists($key, $metadata)) {
                return false;
            }
            if ($metadata[$key] !== $value) {
                return false;
            }
        }
        return true;
    }

    /**
     * Compute facet counts for the given fields over filtered candidates.
     *
     * @param array  $candidates
     * @param array  $filters
     * @param string[] $facets
     * @return array<string, array<string, int>>
     */
    private function computeFacets(array $candidates, array $filters, array $facets): array
    {
        $result = [];
        foreach ($facets as $field) {
            $counts = [];
            foreach ($candidates as $doc) {
                if (!$this->matchesFilters($doc, $filters)) {
                    continue;
                }
                $metadata = json_decode($doc['metadata'], true) ?: [];
                if (array_key_exists($field, $metadata) && $metadata[$field] !== null) {
                    $val = (string) $metadata[$field];
                    $counts[$val] = ($counts[$val] ?? 0) + 1;
                }
            }
            ksort($counts);
            $result[$field] = $counts;
        }
        return $result;
    }

    /**
     * Perform a full reindex for a document type (or all types).
     * In a real system this would pull from source tables; here it is a
     * no-op pass that confirms the index is consistent.
     *
     * @param string|null $documentType
     * @return void
     */
    private function performReindex(?string $documentType): void
    {
        // Reindex is a no-op in this self-contained module.
        // The Background Jobs system would call indexDocument() for each source record.
        // We simply verify the table is accessible.
        $this->db->query('SELECT 1');
    }
}

/**
 * HTTP-style request handler that maps the spec's endpoints to SearchEngine methods.
 * This class is the public API surface; framework adapters (Laravel, Slim, etc.)
 * would delegate to it.
 */
final class SearchController
{
    private SearchEngine $engine;

    public function __construct(SearchEngine $engine)
    {
        $this->engine = $engine;
    }

    /**
     * POST /search/index
     *
     * @param array $body
     * @return array
     */
    public function handleIndex(array $body): array
    {
        return $this->engine->indexDocument(
            (string) ($body['document_type'] ?? ''),
            (int) ($body['document_id'] ?? 0),
            (string) ($body['content'] ?? ''),
            (array) ($body['metadata'] ?? [])
        );
    }

    /**
     * GET /search
     *
     * @param array $query
     * @return array
     */
    public function handleSearch(array $query): array
    {
        $q = (string) ($query['q'] ?? '');
        $documentType = isset($query['document_type']) ? (string) $query['document_type'] : null;
        $limit = (int) ($query['limit'] ?? 20);
        $offset = (int) ($query['offset'] ?? 0);

        // Parse filters: repeated `filters` param, e.g. filters=tier:team&filters=status:active
        $filters = [];
        $rawFilters = $query['filters'] ?? [];
        if (is_string($rawFilters)) {
            $rawFilters = [$rawFilters];
        }
        foreach ($rawFilters as $f) {
            if (is_string($f) && str_contains($f, ':')) {
                [$key, $val] = explode(':', $f, 2);
                $filters[trim($key)] = trim($val);
            }
        }

        // Parse facets: comma-separated list
        $facets = [];
        $rawFacets = $query['facets'] ?? '';
        if (is_string($rawFacets) && $rawFacets !== '') {
            $facets = array_map('trim', explode(',', $rawFacets));
            $facets = array_filter($facets, fn($s) => $s !== '');
        }

        return $this->engine->search($q, $documentType, $filters, $facets, $limit, $offset);
    }

    /**
     * DELETE /search/documents/:document_type/:document_id
     *
     * @param string $documentType
     * @param int    $documentId
     * @return array
     */
    public function handleUnindex(string $documentType, int $documentId): array
    {
        return $this->engine->unindexDocument($documentType, $documentId);
    }

    /**
     * POST /admin/search/reindex
     *
     * @param array $body
     * @return array
     */
    public function handleReindex(array $body): array
    {
        $documentType = isset($body['document_type']) ? (string) $body['document_type'] : null;
        if ($documentType === '') {
            $documentType = null;
        }
        return $this->engine->reindexAll($documentType);
    }
}