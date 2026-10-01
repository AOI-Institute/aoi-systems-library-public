<?php

declare(strict_types=1);

namespace SaaS\Search\Tests;

use PDO;
use SaaS\Search\SearchEngine;
use SaaS\Search\SearchController;

/**
 * Minimal test runner (no external dependencies).
 * Run: php full_text_search_indexing_php_tests.php
 */

// Bootstrap: load the implementation
require_once __DIR__ . '/full_text_search_indexing_php.php';

use SaaS\Search\SearchEngine as Engine;
use SaaS\Search\SearchController as Controller;

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------
$tests = [];
$passed = 0;
$failed = 0;

function assert_true(bool $cond, string $msg): void
{
    global $passed, $failed;
    if ($cond) {
        $passed++;
        echo "  ✓ $msg\n";
    } else {
        $failed++;
        echo "  ✗ $msg\n";
    }
}

function assert_eq(mixed $expected, mixed $actual, string $msg): void
{
    global $passed, $failed;
    if ($expected === $actual) {
        $passed++;
        echo "  ✓ $msg\n";
    } else {
        $failed++;
        echo "  ✗ $msg\n";
        echo "    expected: " . var_export($expected, true) . "\n";
        echo "    actual:   " . var_export($actual, true) . "\n";
    }
}

function assert_contains(array $haystack, mixed $needle, string $msg): void
{
    global $passed, $failed;
    if (in_array($needle, $haystack, true)) {
        $passed++;
        echo "  ✓ $msg\n";
    } else {
        $failed++;
        echo "  ✗ $msg\n";
        echo "    haystack: " . json_encode($haystack) . "\n";
    }
}

function assert_gte(float $actual, float $threshold, string $msg): void
{
    global $passed, $failed;
    if ($actual >= $threshold) {
        $passed++;
        echo "  ✓ $msg\n";
    } else {
        $failed++;
        echo "  ✗ $msg\n";
        echo "    actual: $actual, threshold: $threshold\n";
    }
}

function assert_lte(float $actual, float $threshold, string $msg): void
{
    global $passed, $failed;
    if ($actual <= $threshold) {
        $passed++;
        echo "  ✓ $msg\n";
    } else {
        $failed++;
        echo "  ✗ $msg\n";
        echo "    actual: $actual, threshold: $threshold\n";
    }
}

// ---------------------------------------------------------------------------
// Setup: in-memory SQLite database
// ---------------------------------------------------------------------------
function make_engine(): Engine
{
    $pdo = new PDO('sqlite::memory:');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $engine = new Engine($pdo);
    $engine->migrate();
    return $engine;
}

// ---------------------------------------------------------------------------
// TEST 1: Index user, search finds it
// ---------------------------------------------------------------------------
echo "TEST 1: Index user, search finds it\n";
$engine = make_engine();
$engine->indexDocument(
    'user',
    123,
    'john doe john@example.com team member active',
    ['user_id' => 123, 'email' => 'john@example.com', 'tier' => 'team', 'status' => 'active', 'created_at' => '2026-01-15T00:00:00Z']
);
$res = $engine->search('john', 'user');
assert_eq(1, $res['total'], 'search for "john" returns 1 result');
assert_eq(123, $res['results'][0]['document_id'], 'result document_id is 123');
assert_eq('user', $res['results'][0]['document_type'], 'result document_type is user');
assert_true($res['results'][0]['relevance'] > 0, 'relevance is positive');
assert_eq('john@example.com', $res['results'][0]['metadata']['email'], 'metadata email present');

// ---------------------------------------------------------------------------
// TEST 2: Index deployment, query works
// ---------------------------------------------------------------------------
echo "\nTEST 2: Index deployment, query works\n";
$engine->indexDocument(
    'deployment',
    456,
    'stripe integration payment gateway production',
    ['deployment_id' => 456, 'tier' => 'team', 'status' => 'active', 'created_at' => '2026-01-16T00:00:00Z']
);
$res = $engine->search('stripe', 'deployment');
assert_eq(1, $res['total'], 'search for "stripe" in deployments returns 1');
assert_eq(456, $res['results'][0]['document_id'], 'deployment id 456 found');

// ---------------------------------------------------------------------------
// TEST 3: Partial match: "stri" finds "stripe"
// ---------------------------------------------------------------------------
echo "\nTEST 3: Partial match\n";
$res = $engine->search('stri', 'deployment');
assert_eq(1, $res['total'], '"stri" finds "stripe" via prefix/partial match');
assert_eq(456, $res['results'][0]['document_id'], 'correct deployment found');

// ---------------------------------------------------------------------------
// TEST 4: Filters: tier:team returns only team tier
// ---------------------------------------------------------------------------
echo "\nTEST 4: Filters\n";
$engine->indexDocument(
    'deployment',
    789,
    'stripe integration payment gateway staging',
    ['deployment_id' => 789, 'tier' => 'enterprise', 'status' => 'active', 'created_at' => '2026-01-17T00:00:00Z']
);
$res = $engine->search('stripe', 'deployment', ['tier' => 'team']);
assert_eq(1, $res['total'], 'filter tier:team returns 1 result');
assert_eq(456, $res['results'][0]['document_id'], 'only team-tier deployment returned');

$res2 = $engine->search('stripe', 'deployment', ['tier' => 'enterprise']);
assert_eq(1, $res2['total'], 'filter tier:enterprise returns 1 result');
assert_eq(789, $res2['results'][0]['document_id'], 'only enterprise-tier deployment returned');

// ---------------------------------------------------------------------------
// TEST 5: Facets: shows count per status
// ---------------------------------------------------------------------------
echo "\nTEST 5: Facets\n";
$engine->indexDocument(
    'deployment',
    1001,
    'stripe integration draft',
    ['deployment_id' => 1001, 'tier' => 'team', 'status' => 'draft', 'created_at' => '2026-01-18T00:00:00Z']
);
$res = $engine->search('stripe', 'deployment', [], ['status', 'tier']);
assert_true(isset($res['facets']), 'facets key present');
assert_true(isset($res['facets']['status']), 'status facet present');
assert_true(isset($res['facets']['tier']), 'tier facet present');
// status: active (456, 789), draft (1001)
assert_eq(2, $res['facets']['status']['active'] ?? 0, 'status active count = 2');
assert_eq(1, $res['facets']['status']['draft'] ?? 0, 'status draft count = 1');
// tier: team (456, 1001), enterprise (789)
assert_eq(2, $res['facets']['tier']['team'] ?? 0, 'tier team count = 2');
assert_eq(1, $res['facets']['tier']['enterprise'] ?? 0, 'tier enterprise count = 1');

// ---------------------------------------------------------------------------
// TEST 6: Unindex: document no longer found after delete
// ---------------------------------------------------------------------------
echo "\nTEST 6: Unindex\n";
$engine->unindexDocument('deployment', 456);
$res = $engine->search('stripe', 'deployment');
assert_eq(2, $res['total'], 'after unindex, 2 deployments remain');
$ids = array_column($res['results'], 'document_id');
assert_true(!in_array(456, $ids, true), 'document 456 no longer in results');

// ---------------------------------------------------------------------------
// TEST 7: Real-time: index updated within 100ms of create
// ---------------------------------------------------------------------------
echo "\nTEST 7: Real-time indexing\n";
$start = microtime(true);
$engine->indexDocument(
    'user',
    200,
    'realtime test user realtime@example.com',
    ['user_id' => 200, 'tier' => 'solo', 'status' => 'active', 'created_at' => '2026-01-19T00:00:00Z']
);
$res = $engine->search('realtime', 'user');
$elapsed = (microtime(true) - $start) * 1000; // ms
assert_eq(1, $res['total'], 'document immediately searchable after index');
assert_lte($elapsed, 100.0, "index+search completed in {$elapsed}ms (< 100ms)");

// ---------------------------------------------------------------------------
// TEST 8: Performance: 1M documents, search returns < 200ms
// ---------------------------------------------------------------------------
echo "\nTEST 8: Performance (1M documents)\n";
$perfEngine = make_engine();
$batchSize = 10000;
$totalDocs = 1000000;
$batchStart = microtime(true);
for ($i = 0; $i < $totalDocs; $i += $batchSize) {
    $perfEngine->db->beginTransaction();
    for ($j = 0; $j < $batchSize && ($i + $j) < $totalDocs; $j++) {
        $id = $i + $j;
        $perfEngine->indexDocument(
            'user',
            $id,
            "user{$id} performance test document content",
            ['user_id' => $id, 'tier' => 'team', 'status' => 'active', 'created_at' => '2026-01-20T00:00:00Z']
        );
    }
    $perfEngine->db->commit();
}
$indexTime = (microtime(true) - $batchStart) * 1000;
echo "  (indexed {$totalDocs} docs in " . round($indexTime) . "ms)\n";

$searchStart = microtime(true);
$perfRes = $perfEngine->search('performance', 'user', [], [], 20, 0);
$searchTime = (microtime(true) - $searchStart) * 1000;
echo "  (search returned in " . round($searchTime, 2) . "ms, total={$perfRes['total']})\n";
assert_lte($searchTime, 200.0, "search over 1M docs in {$searchTime}ms (< 200ms)");
assert_true($perfRes['total'] > 0, 'performance search found results');

// ---------------------------------------------------------------------------
// TEST 9: Relevance: exact match ranks higher than partial
// ---------------------------------------------------------------------------
echo "\nTEST 9: Relevance ordering\n";
$relEngine = make_engine();
$relEngine->indexDocument('user', 1, 'exact match document', ['tier' => 'team', 'status' => 'active']);
$relEngine->indexDocument('user', 2, 'exactness is a quality', ['tier' => 'team', 'status' => 'active']);
$res = $relEngine->search('exact', 'user');
assert_eq(2, $res['total'], 'both docs match "exact"');
assert_eq(1, $res['results'][0]['document_id'], 'exact match (doc 1) ranks first');
assert_eq(2, $res['results'][1]['document_id'], 'partial match (doc 2) ranks second');
assert_true(
    $res['results'][0]['relevance'] > $res['results'][1]['relevance'],
    'exact match relevance > partial match relevance'
);

// ---------------------------------------------------------------------------
// TEST 10: Multi-word query (AND semantics)
// ---------------------------------------------------------------------------
echo "\nTEST 10: Multi-word query\n";
$mwEngine = make_engine();
$mwEngine->indexDocument('deployment', 10, 'stripe integration payment', ['tier' => 'team', 'status' => 'active']);
$mwEngine->indexDocument('deployment', 11, 'stripe only', ['tier' => 'team', 'status' => 'active']);
$mwEngine->indexDocument('deployment', 12, 'integration only', ['tier' => 'team', 'status' => 'active']);
$res = $mwEngine->search('stripe integration', 'deployment');
assert_eq(1, $res['total'], 'multi-word "stripe integration" matches only doc 10');
assert_eq(10, $res['results'][0]['document_id'], 'correct doc for multi-word query');

// ---------------------------------------------------------------------------
// TEST 11: Controller endpoint shapes
// ---------------------------------------------------------------------------
echo "\nTEST 11: Controller endpoint response shapes\n";
$ctrlEngine = make_engine();
$ctrl = new Controller($ctrlEngine);

// POST /search/index
$idxRes = $ctrl->handleIndex([
    'document_type' => 'user',
    'document_id' => 500,
    'content' => 'controller test user',
    'metadata' => ['user_id' => 500, 'tier' => 'solo', 'status' => 'active'],
]);
assert_true($idxRes['success'] === true, 'index response has success=true');
assert_true(isset($idxRes['indexed_at']), 'index response has indexed_at');

// GET /search
$searchRes = $ctrl->handleSearch(['q' => 'controller', 'document_type' => 'user', 'limit' => 20, 'offset' => 0]);
assert_true(isset($searchRes['results']), 'search response has results');
assert_true(isset($searchRes['total']), 'search response has total');
assert_true(isset($searchRes['has_more']), 'search response has has_more');
assert_eq(1, $searchRes['total'], 'controller search finds 1 result');

// GET /search with filters
$ctrlEngine->indexDocument('user', 501, 'controller test user two', ['user_id' => 501, 'tier' => 'team', 'status' => 'active']);
$ctrlEngine->indexDocument('user', 502, 'controller test user three', ['user_id' => 502, 'tier' => 'enterprise', 'status' => 'active']);
$filteredRes = $ctrl->handleSearch(['q' => 'controller', 'document_type' => 'user', 'filters' => ['tier:team']]);
assert_eq(1, $filteredRes['total'], 'controller filter tier:team returns 1');
assert_eq(501, $filteredRes['results'][0]['document_id'], 'correct doc for filtered search');

// GET /search with facets
$facetRes = $ctrl->handleSearch(['q' => 'controller', 'document_type' => 'user', 'facets' => 'tier,status']);
assert_true(isset($facetRes['facets']), 'controller facets present');
assert_true(isset($facetRes['facets']['tier']), 'tier facet present');
assert_true(isset($facetRes['facets']['status']), 'status facet present');

// DELETE /search/documents/:type/:id
$delRes = $ctrl->handleUnindex('user', 500);
assert_true($delRes['success'] === true, 'unindex response has success=true');
$afterDel = $ctrl->handleSearch(['q' => 'controller', 'document_type' => 'user']);
assert_eq(2, $afterDel['total'], 'after unindex, 2 users remain');

// POST /admin/search/reindex
$reindexRes = $ctrl->handleReindex(['document_type' => 'user']);
assert_true($reindexRes['success'] === true, 'reindex response has success=true');
assert_true(isset($reindexRes['job_id']), 'reindex response has job_id');
assert_eq('enqueued', $reindexRes['status'], 'reindex status is enqueued');

// Reindex with null type
$reindexAll = $ctrl->handleReindex([]);
assert_true($reindexAll['success'] === true, 'reindex all types success');
assert_eq('enqueued', $reindexAll['status'], 'reindex all status enqueued');

// ---------------------------------------------------------------------------
// TEST 12: Empty query returns all filtered docs
// ---------------------------------------------------------------------------
echo "\nTEST 12: Empty query\n";
$eqEngine = make_engine();
$eqEngine->indexDocument('user', 1, 'alpha', ['tier' => 'team', 'status' => 'active']);
$eqEngine->indexDocument('user', 2, 'beta', ['tier' => 'team', 'status' => 'draft']);
$eqEngine->indexDocument('user', 3, 'gamma', ['tier' => 'solo', 'status' => 'active']);
$res = $eqEngine->search('', 'user');
assert_eq(3, $res['total'], 'empty query returns all 3 users');
$res = $eqEngine->search('', 'user', ['status' => 'active']);
assert_eq(2, $res['total'], 'empty query with filter returns 2');

// ---------------------------------------------------------------------------
// TEST 13: Pagination
// ---------------------------------------------------------------------------
echo "\nTEST 13: Pagination\n";
$pgEngine = make_engine();
for ($i = 1; $i <= 25; $i++) {
    $pgEngine->indexDocument('user', $i, "pagination test user {$i}", ['tier' => 'team', 'status' => 'active']);
}
$res = $pgEngine->search('pagination', 'user', [], [], 10, 0);
assert_eq(25, $res['total'], 'total is 25');
assert_eq(10, count($res['results']), 'first page has 10 results');
assert_true($res['has_more'] === true, 'has_more is true for first page');

$res2 = $pgEngine->search('pagination', 'user', [], [], 10, 20);
assert_eq(5, count($res2['results']), 'last page has 5 results');
assert_true($res2['has_more'] === false, 'has_more is false for last page');

// ---------------------------------------------------------------------------
// TEST 14: Stop words are removed
// ---------------------------------------------------------------------------
echo "\nTEST 14: Stop word handling\n";
$swEngine = make_engine();
$swEngine->indexDocument('user', 1, 'the quick brown fox', ['tier' => 'team', 'status' => 'active']);
$res = $swEngine->search('the', 'user');
assert_eq(0, $res['total'], 'stop word "the" alone returns 0 results');
$res = $swEngine->search('quick', 'user');
assert_eq(1, $res['total'], 'non-stop word "quick" returns 1 result');

// ---------------------------------------------------------------------------
// TEST 15: Upsert (re-index same document)
// ---------------------------------------------------------------------------
echo "\nTEST 15: Upsert\n";
$upEngine = make_engine();
$upEngine->indexDocument('user', 1, 'original content', ['tier' => 'team', 'status' => 'active']);
$upEngine->indexDocument('user', 1, 'updated content', ['tier' => 'team', 'status' => 'draft']);
$res = $upEngine->search('updated', 'user');
assert_eq(1, $res['total'], 'updated content is searchable');
assert_eq('draft', $res['results'][0]['metadata']['status'], 'metadata updated to draft');
$res2 = $upEngine->search('original', 'user');
assert_eq(0, $res2['total'], 'original content no longer searchable');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
echo "\n========================================\n";
echo "PASSED: $passed\n";
echo "FAILED: $failed\n";
echo "TOTAL:  " . ($passed + $failed) . "\n";
echo "========================================\n";

exit($failed > 0 ? 1 : 0);