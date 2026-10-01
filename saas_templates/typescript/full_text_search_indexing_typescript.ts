export const DDL = `
CREATE TABLE IF NOT EXISTS search_index (
    document_type VARCHAR(255) NOT NULL,
    document_id VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    indexed_at VARCHAR(64) NOT NULL,
    metadata TEXT NOT NULL, -- JSON string
    PRIMARY KEY (document_type, document_id)
);
CREATE INDEX IF NOT EXISTS idx_search_index_type ON search_index(document_type);
`;

export interface IndexRequest {
  document_type: string;
  document_id: string | number;
  content: string;
  metadata: Record<string, any>;
}

export interface IndexResponse {
  success: boolean;
  indexed_at: string;
}

export interface SearchQuery {
  q?: string;
  document_type?: string;
  limit?: number;
  offset?: number;
  filters?: string[];
  facets?: string[];
}

export interface SearchResult {
  document_id: string | number;
  document_type: string;
  relevance: number;
  metadata: Record<string, any>;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  has_more: boolean;
  facets?: Record<string, Record<string, number>>;
}

export interface UnindexResponse {
  success: boolean;
}

export interface ReindexResponse {
  success: boolean;
  job_id: string;
  status: 'enqueued';
}

interface IndexDocument {
  document_type: string;
  document_id: string | number;
  content: string;
  indexed_at: string;
  metadata: Record<string, any>;
  tokens: string[];
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "to", "of", "in", "for", "with", "on", "at", "by"
]);

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().split(/[^a-z0-9]+/);
  const result: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.length > 0 && !STOP_WORDS.has(w)) {
      result.push(w);
    }
  }
  return result;
}

export function parseQuery(q?: string, explicitFilters?: string[]): { queryText: string; filters: Map<string, string> } {
  const filters = new Map<string, string>();

  if (explicitFilters) {
    for (const f of explicitFilters) {
      const idx = f.indexOf(':');
      if (idx > 0) {
        const key = f.substring(0, idx).trim();
        const val = f.substring(idx + 1).trim();
        filters.set(key, val);
      }
    }
  }

  if (!q) {
    return { queryText: '', filters };
  }

  const inlineFilterRegex = /(\w+):"([^"]+)"|(\w+):([^\s]+)/g;
  let match;
  let cleanedQuery = q;

  while ((match = inlineFilterRegex.exec(q)) !== null) {
    const key = match[1] || match[3];
    const val = match[2] || match[4];
    filters.set(key, val);
    cleanedQuery = cleanedQuery.replace(match[0], '');
  }

  cleanedQuery = cleanedQuery.replace(/\s+/g, ' ').trim();
  return { queryText: cleanedQuery, filters };
}

export class FullTextSearchService {
  private documents = new Map<string, IndexDocument>();
  private documentsByType = new Map<string, Set<string>>();
  private invertedIndex = new Map<string, Set<string>>();
  private metadataIndex = new Map<string, Map<string, Set<string>>>();

  public async indexDocument(doc: IndexRequest): Promise<IndexResponse> {
    const { document_type, document_id, content, metadata } = doc;
    const docKey = `${document_type}:${document_id}`;
    const indexed_at = new Date().toISOString();

    if (this.documents.has(docKey)) {
      this.unindexDocumentInternal(document_type, document_id);
    }

    const tokens = tokenize(content);
    const indexDoc: IndexDocument = {
      document_type,
      document_id,
      content,
      indexed_at,
      metadata: metadata || {},
      tokens
    };

    this.documents.set(docKey, indexDoc);

    if (!this.documentsByType.has(document_type)) {
      this.documentsByType.set(document_type, new Set());
    }
    this.documentsByType.get(document_type)!.add(docKey);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!this.invertedIndex.has(token)) {
        this.invertedIndex.set(token, new Set());
      }
      this.invertedIndex.get(token)!.add(docKey);
    }

    if (metadata) {
      for (const [key, val] of Object.entries(metadata)) {
        const valStr = String(val);
        if (!this.metadataIndex.has(key)) {
          this.metadataIndex.set(key, new Map());
        }
        const valMap = this.metadataIndex.get(key)!;
        if (!valMap.has(valStr)) {
          valMap.set(valStr, new Set());
        }
        valMap.get(valStr)!.add(docKey);
      }
    }

    return { success: true, indexed_at };
  }

  public async unindexDocument(documentType: string, documentId: string | number): Promise<UnindexResponse> {
    this.unindexDocumentInternal(documentType, documentId);
    return { success: true };
  }

  private unindexDocumentInternal(documentType: string, documentId: string | number) {
    const docKey = `${documentType}:${documentId}`;
    const doc = this.documents.get(docKey);
    if (!doc) return;

    this.documents.delete(docKey);

    const typeSet = this.documentsByType.get(documentType);
    if (typeSet) {
      typeSet.delete(docKey);
      if (typeSet.size === 0) {
        this.documentsByType.delete(documentType);
      }
    }

    for (let i = 0; i < doc.tokens.length; i++) {
      const token = doc.tokens[i];
      const docSet = this.invertedIndex.get(token);
      if (docSet) {
        docSet.delete(docKey);
        if (docSet.size === 0) {
          this.invertedIndex.delete(token);
        }
      }
    }

    if (doc.metadata) {
      for (const [key, val] of Object.entries(doc.metadata)) {
        const valStr = String(val);
        const valMap = this.metadataIndex.get(key);
        if (valMap) {
          const docSet = valMap.get(valStr);
          if (docSet) {
            docSet.delete(docKey);
            if (docSet.size === 0) {
              valMap.delete(valStr);
            }
          }
          if (valMap.size === 0) {
            this.metadataIndex.delete(key);
          }
        }
      }
    }
  }

  public async search(query: SearchQuery): Promise<SearchResponse> {
    const { queryText, filters } = parseQuery(query.q, query.filters);

    if (query.document_type) {
      filters.set('document_type', query.document_type);
    }

    let candidates: Set<string>;
    const docTypeFilter = filters.get('document_type');
    if (docTypeFilter) {
      candidates = new Set(this.documentsByType.get(docTypeFilter) || []);
    } else {
      candidates = new Set(this.documents.keys());
    }

    for (const [fKey, fVal] of filters.entries()) {
      if (fKey === 'document_type') continue;
      const valMap = this.metadataIndex.get(fKey);
      if (!valMap) {
        return { results: [], total: 0, has_more: false };
      }
      const filterDocs = valMap.get(fVal);
      if (!filterDocs) {
        return { results: [], total: 0, has_more: false };
      }
      for (const docKey of candidates) {
        if (!filterDocs.has(docKey)) {
          candidates.delete(docKey);
        }
      }
      if (candidates.size === 0) {
        return { results: [], total: 0, has_more: false };
      }
    }

    const queryTokens = tokenize(queryText);
    if (queryTokens.length > 0) {
      for (let i = 0; i < queryTokens.length; i++) {
        const qToken = queryTokens[i];
        const tokenMatches = new Set<string>();

        for (const [vocabToken, docKeys] of this.invertedIndex.entries()) {
          if (vocabToken === qToken || vocabToken.startsWith(qToken) || vocabToken.includes(qToken)) {
            for (const docKey of docKeys) {
              tokenMatches.add(docKey);
            }
          }
        }

        for (const docKey of candidates) {
          if (!tokenMatches.has(docKey)) {
            candidates.delete(docKey);
          }
        }

        if (candidates.size === 0) {
          break;
        }
      }
    }

    const scoredResults: { doc: IndexDocument; relevance: number }[] = [];

    for (const docKey of candidates) {
      const doc = this.documents.get(docKey)!;
      let relevance = 1.0;

      if (queryTokens.length > 0) {
        let totalScore = 0;
        for (let i = 0; i < queryTokens.length; i++) {
          const qToken = queryTokens[i];
          let bestTokenScore = 0;
          for (let j = 0; j < doc.tokens.length; j++) {
            const docToken = doc.tokens[j];
            if (docToken === qToken) {
              bestTokenScore = Math.max(bestTokenScore, 1.0);
            } else if (docToken.startsWith(qToken)) {
              bestTokenScore = Math.max(bestTokenScore, 0.75);
            } else if (docToken.includes(qToken)) {
              bestTokenScore = Math.max(bestTokenScore, 0.5);
            }
          }
          totalScore += bestTokenScore;
        }
        relevance = parseFloat((totalScore / queryTokens.length).toFixed(4));
      }

      scoredResults.push({ doc, relevance });
    }

    const facetResults: Record<string, Record<string, number>> = {};
    if (query.facets && query.facets.length > 0) {
      for (let i = 0; i < query.facets.length; i++) {
        facetResults[query.facets[i]] = {};
      }

      for (let i = 0; i < scoredResults.length; i++) {
        const { doc } = scoredResults[i];
        for (let j = 0; j < query.facets.length; j++) {
          const facetField = query.facets[j];
          const val = doc.metadata[facetField];
          if (val !== undefined && val !== null) {
            const valStr = String(val);
            facetResults[facetField][valStr] = (facetResults[facetField][valStr] || 0) + 1;
          }
        }
      }
    }

    scoredResults.sort((a, b) => {
      if (b.relevance !== a.relevance) {
        return b.relevance - a.relevance;
      }
      return new Date(b.doc.indexed_at).getTime() - new Date(a.doc.indexed_at).getTime();
    });

    const total = scoredResults.length;
    const limit = query.limit !== undefined ? query.limit : 20;
    const offset = query.offset !== undefined ? query.offset : 0;
    const paginated = scoredResults.slice(offset, offset + limit);
    const has_more = offset + paginated.length < total;

    const results = paginated.map(({ doc, relevance }) => ({
      document_id: doc.document_id,
      document_type: doc.document_type,
      relevance,
      metadata: doc.metadata
    }));

    const response: SearchResponse = {
      results,
      total,
      has_more
    };

    if (query.facets && query.facets.length > 0) {
      response.facets = facetResults;
    }

    return response;
  }

  public async reindexAll(documentType: string | null): Promise<ReindexResponse> {
    const jobId = Math.random().toString(36).substring(2, 15);
    
    setTimeout(async () => {
      const docsToReindex = Array.from(this.documents.values()).filter(
        doc => documentType === null || doc.document_type === documentType
      );
      for (const doc of docsToReindex) {
        await this.indexDocument({
          document_type: doc.document_type,
          document_id: doc.document_id,
          content: doc.content,
          metadata: doc.metadata
        });
      }
    }, 0);

    return {
      success: true,
      job_id: jobId,
      status: 'enqueued'
    };
  }

  public clear(): void {
    this.documents.clear();
    this.documentsByType.clear();
    this.invertedIndex.clear();
    this.metadataIndex.clear();
  }
}

export const searchService = new FullTextSearchService();