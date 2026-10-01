using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace SaaS.Search
{
    // DTOs matching API contract
    public class IndexRequest
    {
        [JsonPropertyName("document_type")]
        public string DocumentType { get; set; }

        [JsonPropertyName("document_id")]
        public string DocumentId { get; set; }

        [JsonPropertyName("content")]
        public string Content { get; set; }

        [JsonPropertyName("metadata")]
        public Dictionary<string, object> Metadata { get; set; }
    }

    public class IndexResponse
    {
        [JsonPropertyName("success")]
        public bool Success { get; set; }

        [JsonPropertyName("indexed_at")]
        public DateTime IndexedAt { get; set; }
    }

    public class SearchRequest
    {
        public string Query { get; set; }
        public string DocumentType { get; set; }
        public int Limit { get; set; } = 20;
        public int Offset { get; set; } = 0;
        public List<string> Filters { get; set; } = new List<string>();
        public List<string> Facets { get; set; } = new List<string>();
    }

    public class SearchResultItem
    {
        [JsonPropertyName("document_id")]
        public string DocumentId { get; set; }

        [JsonPropertyName("document_type")]
        public string DocumentType { get; set; }

        [JsonPropertyName("relevance")]
        public double Relevance { get; set; }

        [JsonPropertyName("metadata")]
        public Dictionary<string, object> Metadata { get; set; }
    }

    public class SearchResponse
    {
        [JsonPropertyName("results")]
        public List<SearchResultItem> Results { get; set; } = new List<SearchResultItem>();

        [JsonPropertyName("total")]
        public int Total { get; set; }

        [JsonPropertyName("has_more")]
        public bool HasMore { get; set; }

        [JsonPropertyName("facets")]
        public Dictionary<string, Dictionary<string, int>> Facets { get; set; }
    }

    public class UnindexResponse
    {
        [JsonPropertyName("success")]
        public bool Success { get; set; }
    }

    public class ReindexRequest
    {
        [JsonPropertyName("document_type")]
        public string DocumentType { get; set; } // null => all
    }

    public class ReindexResponse
    {
        [JsonPropertyName("success")]
        public bool Success { get; set; }

        [JsonPropertyName("job_id")]
        public string JobId { get; set; }

        [JsonPropertyName("status")]
        public string Status { get; set; }
    }

    // Internal representation of a document
    internal class SearchDocument
    {
        public string DocumentKey => $"{DocumentType}:{DocumentId}";
        public string DocumentType { get; set; }
        public string DocumentId { get; set; }
        public string Content { get; set; }
        public DateTime IndexedAt { get; set; }
        public Dictionary<string, object> Metadata { get; set; }
    }

    public class SearchIndexService
    {
        // Inverted index: term -> set of document keys
        private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> _invertedIndex
            = new ConcurrentDictionary<string, ConcurrentDictionary<string, byte>>();

        // Document store
        private readonly ConcurrentDictionary<string, SearchDocument> _documents
            = new ConcurrentDictionary<string, SearchDocument>();

        // Stop words
        private static readonly HashSet<string> StopWords = new HashSet<string>
        {
            "the","and","or","a","an","of","to","in","for","on","with","at","by"
        };

        // Background job queue (simplified)
        private readonly ConcurrentQueue<Func<Task>> _jobQueue = new ConcurrentQueue<Func<Task>>();
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();

        public SearchIndexService()
        {
            // Start background worker
            Task.Run(ProcessJobsAsync);
        }

        // Tokenizer
        private static IEnumerable<string> Tokenize(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) yield break;
            var tokens = text.Split(new[] { ' ', '\t', '\r', '\n', ',', '.', ';', ':', '-', '_' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (var raw in tokens)
            {
                var token = raw.Trim().ToLowerInvariant();
                if (token.Length == 0) continue;
                if (StopWords.Contains(token)) continue;
                yield return token;
            }
        }

        // Index a document (create or update)
        public async Task<IndexResponse> IndexDocumentAsync(IndexRequest request)
        {
            var doc = new SearchDocument
            {
                DocumentType = request.DocumentType,
                DocumentId = request.DocumentId,
                Content = request.Content,
                IndexedAt = DateTime.UtcNow,
                Metadata = request.Metadata ?? new Dictionary<string, object>()
            };

            var key = doc.DocumentKey;
            // Remove old terms if updating
            if (_documents.TryGetValue(key, out var oldDoc))
            {
                var oldTerms = Tokenize(oldDoc.Content);
                foreach (var term in oldTerms.Distinct())
                {
                    if (_invertedIndex.TryGetValue(term, out var set))
                    {
                        set.TryRemove(key, out _);
                        if (set.IsEmpty) _invertedIndex.TryRemove(term, out _);
                    }
                }
            }

            // Store document
            _documents[key] = doc;

            // Index terms
            var terms = Tokenize(doc.Content).Distinct();
            foreach (var term in terms)
            {
                var set = _invertedIndex.GetOrAdd(term, _ => new ConcurrentDictionary<string, byte>());
                set[key] = 0;
            }

            return await Task.FromResult(new IndexResponse
            {
                Success = true,
                IndexedAt = doc.IndexedAt
            });
        }

        // Search
        public async Task<SearchResponse> SearchAsync(SearchRequest request)
        {
            var queryTerms = Tokenize(request.Query).ToList();
            var matchedKeys = new HashSet<string>();

            // Gather candidate docs
            foreach (var term in queryTerms)
            {
                if (_invertedIndex.TryGetValue(term, out var set))
                {
                    foreach (var key in set.Keys) matchedKeys.Add(key);
                }

                // Prefix match
                var prefixMatches = _invertedIndex.Keys
                    .Where(k => k.StartsWith(term) && k != term);
                foreach (var pref in prefixMatches)
                {
                    if (_invertedIndex.TryGetValue(pref, out var prefSet))
                    {
                        foreach (var key in prefSet.Keys) matchedKeys.Add(key);
                    }
                }
            }

            // Filter by document_type
            if (!string.IsNullOrWhiteSpace(request.DocumentType))
            {
                matchedKeys.RemoveWhere(k => !k.StartsWith($"{request.DocumentType}:"));
            }

            // Apply metadata filters
            foreach (var filter in request.Filters ?? Enumerable.Empty<string>())
            {
                var parts = filter.Split(':', 2);
                if (parts.Length != 2) continue;
                var field = parts[0];
                var value = parts[1];
                matchedKeys.RemoveWhere(k =>
                {
                    if (!_documents.TryGetValue(k, out var doc)) return true;
                    if (!doc.Metadata.TryGetValue(field, out var metaVal)) return true;
                    return !string.Equals(metaVal?.ToString(), value, StringComparison.OrdinalIgnoreCase);
                });
            }

            // Compute relevance
            var results = new List<SearchResultItem>();
            foreach (var key in matchedKeys)
            {
                if (!_documents.TryGetValue(key, out var doc)) continue;
                double relevance = 0;
                foreach (var term in queryTerms)
                {
                    var contentLower = doc.Content.ToLowerInvariant();
                    if (contentLower.Contains(term))
                    {
                        relevance += 2; // exact/partial match
                    }
                    else if (contentLower.Split(' ').Any(w => w.StartsWith(term)))
                    {
                        relevance += 0.5; // prefix
                    }
                }
                results.Add(new SearchResultItem
                {
                    DocumentId = doc.DocumentId,
                    DocumentType = doc.DocumentType,
                    Relevance = relevance,
                    Metadata = doc.Metadata
                });
            }

            // Sort by relevance desc then by indexed_at desc
            results = results
                .OrderByDescending(r => r.Relevance)
                .ThenByDescending(r => _documents[$"{r.DocumentType}:{r.DocumentId}"].IndexedAt)
                .ToList();

            var total = results.Count;
            var paged = results.Skip(request.Offset).Take(request.Limit).ToList();
            var hasMore = request.Offset + request.Limit < total;

            // Facets
            Dictionary<string, Dictionary<string, int>> facets = null;
            if (request.Facets != null && request.Facets.Any())
            {
                facets = new Dictionary<string, Dictionary<string, int>>();
                foreach (var facetField in request.Facets)
                {
                    var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                    foreach (var item in results)
                    {
                        if (item.Metadata != null && item.Metadata.TryGetValue(facetField, out var val))
                        {
                            var key = val?.ToString() ?? "null";
                            if (!counts.ContainsKey(key)) counts[key] = 0;
                            counts[key]++;
                        }
                    }
                    facets[facetField] = counts;
                }
            }

            return await Task.FromResult(new SearchResponse
            {
                Results = paged,
                Total = total,
                HasMore = hasMore,
                Facets = facets
            });
        }

        // Unindex document
        public async Task<UnindexResponse> UnindexDocumentAsync(string documentType, string documentId)
        {
            var key = $"{documentType}:{documentId}";
            if (_documents.TryRemove(key, out var doc))
            {
                var terms = Tokenize(doc.Content).Distinct();
                foreach (var term in terms)
                {
                    if (_invertedIndex.TryGetValue(term, out var set))
                    {
                        set.TryRemove(key, out _);
                        if (set.IsEmpty) _invertedIndex.TryRemove(term, out _);
                    }
                }
            }
            return await Task.FromResult(new UnindexResponse { Success = true });
        }

        // Reindex all (admin)
        public async Task<ReindexResponse> ReindexAsync(ReindexRequest request)
        {
            var jobId = Guid.NewGuid().ToString();
            _jobQueue.Enqueue(async () =>
            {
                // Simple reindex: clear and rebuild
                _invertedIndex.Clear();
                var docs = request.DocumentType == null
                    ? _documents.Values
                    : _documents.Values.Where(d => d.DocumentType == request.DocumentType);
                foreach (var doc in docs)
                {
                    var terms = Tokenize(doc.Content).Distinct();
                    foreach (var term in terms)
                    {
                        var set = _invertedIndex.GetOrAdd(term, _ => new ConcurrentDictionary<string, byte>());
                        set[doc.DocumentKey] = 0;
                    }
                }
                await Task.CompletedTask;
            });

            return await Task.FromResult(new ReindexResponse
            {
                Success = true,
                JobId = jobId,
                Status = "enqueued"
            });
        }

        // Background job processor
        private async Task ProcessJobsAsync()
        {
            while (!_cts.IsCancellationRequested)
            {
                if (_jobQueue.TryDequeue(out var job))
                {
                    try { await job(); }
                    catch { /* swallow */ }
                }
                else
                {
                    await Task.Delay(100);
                }
            }
        }

        // DDL for persistence (if needed)
        public const string Ddl = @"
CREATE TABLE search_index (
    document_type VARCHAR(50) NOT NULL,
    document_id VARCHAR(100) NOT NULL,
    content TEXT NOT NULL,
    indexed_at TIMESTAMP NOT NULL,
    metadata JSONB NOT NULL,
    PRIMARY KEY (document_type, document_id)
);
";
    }
}