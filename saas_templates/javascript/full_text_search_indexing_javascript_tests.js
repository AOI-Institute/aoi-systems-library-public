const assert = require('assert');
const searchEngine = require('./full_text_search_indexing_javascript');

// Helper to pause
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test 1: Index user, search finds it
(async () => {
  const userPayload = {
    document_type: 'user',
    document_id: 123,
    content: 'john doe john@example.com team member active',
    metadata: {
      user_id: 123,
      email: 'john@example.com',
      tier: 'team',
      status: 'active',
      created_at: '2026-01-15T12:00:00Z'
    }
  };
  const idxRes = searchEngine.indexDocument(userPayload);
  assert.strictEqual(idxRes.success, true);
  const searchRes = searchEngine.search({ q: 'john', document_type: 'user' });
  assert.strictEqual(searchRes.total, 1);
  assert.strictEqual(searchRes.results[0].document_id, 123);
  assert.strictEqual(searchRes.results[0].metadata.email, 'john@example.com');
})();

// Test 2: Index deployment, query works
(async () => {
  const depPayload = {
    document_type: 'deployment',
    document_id: 200,
    content: 'stripe integration for payments',
    metadata: {
      deployment_id: 200,
      tier: 'team',
      status: 'active',
      created_at: '2026-02-01T08:30:00Z'
    }
  };
  const idxRes = searchEngine.indexDocument(depPayload);
  assert.strictEqual(idxRes.success, true);
  const searchRes = searchEngine.search({ q: 'stripe', document_type: 'deployment' });
  assert.strictEqual(searchRes.total, 1);
  assert.strictEqual(searchRes.results[0].document_id, 200);
})();

// Test 3: Partial match: "stri" finds "stripe"
(async () => {
  const searchRes = searchEngine.search({ q: 'stri', document_type: 'deployment' });
  assert.strictEqual(searchRes.total, 1);
  assert.strictEqual(searchRes.results[0].document_id, 200);
})();

// Test 4: Filters: tier:team returns only team tier
(async () => {
  const searchRes = searchEngine.search({
    q: '',
    document_type: 'deployment',
    filters: ['tier:team']
  });
  assert.strictEqual(searchRes.total, 1);
  assert.strictEqual(searchRes.results[0].metadata.tier, 'team');
})();

// Test 5: Facets: shows count per status
(async () => {
  // Add another deployment with different status
  const dep2 = {
    document_type: 'deployment',
    document_id: 201,
    content: 'aws integration',
    metadata: {
      deployment_id: 201,
      tier: 'solo',
      status: 'draft',
      created_at: '2026-02-02T09:00:00Z'
    }
  };
  searchEngine.indexDocument(dep2);
  const facetRes = searchEngine.search({
    q: '',
    document_type: 'deployment',
    facets: 'status,tier'
  });
  assert.strictEqual(facetRes.facets.status.active, 1);
  assert.strictEqual(facetRes.facets.status.draft, 1);
  assert.strictEqual(facetRes.facets.tier.team, 1);
  assert.strictEqual(facetRes.facets.tier.solo, 1);
})();

// Test 6: Unindex: document no longer found after delete
(async () => {
  const delRes = searchEngine.unindexDocument('user', 123);
  assert.strictEqual(delRes.success, true);
  const searchRes = searchEngine.search({ q: 'john', document_type: 'user' });
  assert.strictEqual(searchRes.total, 0);
})();

// Test 7: Real-time: index updated within 100ms of create
(async () => {
  const start = Date.now();
  const payload = {
    document_type: 'user',
    document_id: 124,
    content: 'alice smith alice@example.com',
    metadata: {
      user_id: 124,
      email: 'alice@example.com',
      tier: 'solo',
      status: 'active',
      created_at: '2026-03-01T10:00:00Z'
    }
  };
  searchEngine.indexDocument(payload);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `Indexing took ${elapsed}ms, expected <100ms`);
  const searchRes = searchEngine.search({ q: 'alice', document_type: 'user' });
  assert.strictEqual(searchRes.total, 1);
})();

// Test 8: Reindex all (admin task)
(async () => {
  const reRes = searchEngine.reindexAll({ document_type: null });
  assert.strictEqual(reRes.success, true);
  assert.ok(reRes.job_id);
  // Wait a short moment for async reindex to finish
  await delay(50);
  const searchRes = searchEngine.search({ q: 'stripe', document_type: 'deployment' });
  assert.strictEqual(searchRes.total, 1);
})();

console.log('All full-text search tests passed.');