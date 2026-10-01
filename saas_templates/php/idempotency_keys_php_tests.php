<?php
require_once 'idempotency_keys_php.php';

function resetGlobals() {
    $GLOBALS['IDEM_POTENCY_STORAGE'] = new InMemoryStorage();
    $GLOBALS['IDEMPOTENCY_REQUIRED_METHODS'] = ['POST', 'PATCH'];
}

function expectTrue(bool $condition, string $message = ''): void {
    if (!$condition) {
        throw new Exception("Assertion failed: $message");
    }
}

function expectEquals($expected, $actual, string $message = ''): void {
    if ($expected !== $actual) {
        throw new Exception("Assertion failed: $message. Expected: " . var_export($expected, true) . ", Actual: " . var_export($actual, true));
    }
}

function test_first_call_runs_operation_once() {
    resetGlobals();
    $called = 0;
    $operation = function() use (&$called) {
        $called++;
        return ['status' => 200, 'body' => ['result' => 'success']];
    };
    $result = handle('user1', 'key1', 'POST', '/resource', '{}', $operation);
    expectTrue($called === 1, 'Operation should be called once');
    expectEquals(200, $result['status'], 'Status should be 200');
    expectEquals('application/json', $result['content_type'], 'Content type should be application/json');
    $body = json_decode($result['body'], true);
    expectEquals(['result' => 'success'], $body, 'Body should be success');
}

function test_second_identical_call_returns_stored_response() {
    resetGlobals();
    $called = 0;
    $operation = function() use (&$called) {
        $called++;
        return ['status' => 200, 'body' => ['result' => 'success']];
    };
    $result1 = handle('user1', 'key1', 'POST', '/resource', '{}', $operation);
    $result2 = handle('user1', 'key1', 'POST', '/resource', '{}', $operation);
    expectTrue($called === 1, 'Operation should be called only once');
    expectEquals(200, $result1['status'], 'First status should be 200');
    expectEquals(200, $result2['status'], 'Second status should be 200');
    expectEquals($result1['body'], $result2['body'], 'Bodies should be identical');
}

function test_same_key_different_body_returns_422() {
    resetGlobals();
    $called = 0;
    $operation = function() use (&$called) {
        $called++;
        return ['status' => 200, 'body' => ['result' => 'success']];
    };
    handle('user1', 'key1', 'POST', '/resource', '{"a":1}', $operation);
    $result = handle('user1', 'key1', 'POST', '/resource', '{"a":2}', $operation);
    expectTrue($called === 1, 'Operation should be called only once');
    expectEquals(422, $result['status'], 'Status should be 422');
    expectEquals('application/problem+json', $result['content_type'], 'Content type should be application/problem+json');
    $body = json_decode($result['body'], true);
    expectEquals('https://example.com/problems/payload-mismatch', $body['type'], 'Type should be payload-mismatch');
}

function test_same_key_in_progress_returns_409() {
    resetGlobals();
    $storage = $GLOBALS['IDEM_POTENCY_STORAGE'];
    $now = time();
    $ttl = IDEMPOTENCY_TTL;
    $fingerprint = hash('sha256', 'POST /resource\n{}');
    $storage->claimKey('user1', 'key1', $fingerprint, $now, $ttl);
    $operation = function() {
        return ['status' => 200, 'body' => ['result' => 'success']];
    };
    $result = handle('user1', 'key1', 'POST', '/resource', '{}', $operation);
    expectEquals(409, $result['status'], 'Status should be 409');
    expectEquals('application/problem+json', $result['content_type'], 'Content type should be application/problem+json');
    $body = json_decode($result['body'], true);
    expectEquals('https://example.com/problems/conflict', $body['type'], 'Type should be conflict');
}

function test_required_operation_no_key_returns_400() {
    resetGlobals();
    $operation = function() {
        return ['status' => 200, 'body' => ['result' => 'should not be called']];
    };
    $result = handle('user1', '', 'POST', '/resource', '{}', $operation);
    expectEquals(400, $result['status'], 'Status should be 400');
    expectEquals('application/problem+json', $result['content_type'], 'Content type should be application/problem+json');
    $body = json_decode($result['body'], true);
    expectEquals('https://example.com/problems/missing-idempotency-key', $body['type'], 'Type should be missing-idempotency-key');
}

function test_same_key_different_scope_runs_twice() {
    resetGlobals();
    $called = 0;
    $operation = function() use (&$called) {
        $called++;
        return ['status' => 200, 'body' => ['result' => 'success']];
    };
    handle('user1', 'key1', 'POST', '/resource', '{}', $operation);
    handle('user2', 'key1', 'POST', '/resource', '{}', $operation);
    expectTrue($called === 2, 'Operation should be called twice for different scopes');
}

function test_expired_key_runs_operation_again() {
    resetGlobals();
    $called = 0;
    $operation = function() use (&$called) {
        $called++;
        return ['status' => 200, 'body' => ['result' => 'success']];
    };
    $storage = $GLOBALS['IDEM_POTENCY_STORAGE'];
    $now = time();
    $ttl = 1;
    $fingerprint = hash('sha256', 'POST /resource\n{}');
    $expiredAt = $now - 10;
    $storage->insertRecord('user1', 'key1', $fingerprint, 'completed', 200, json_encode(['result' => 'success']), $now - 20, $expiredAt);
    $result = handle('user1', 'key1', 'POST', '/resource', '{}', $operation);
    expectTrue($called === 1, 'Operation should be called once (the expired record should be treated as absent)');
    expectEquals(200, $result['status'], 'Status should be 200');
    expectEquals('application/json', $result['content_type'], 'Content type should be application/json');
}

function test_operation_that_raises_frees_the_key() {
    resetGlobals();
    $called = 0;
    $operation = function() use (&$called) {
        $called++;
        if ($called === 1) {
            throw new Exception('Temporary failure');
        }
        return ['status' => 200, 'body' => ['result' => 'success']];
    };
    try {
        handle('user1', 'key1', 'POST', '/resource', '{}', $operation);
        expectTrue(false, 'First call should have thrown an exception');
    } catch (Exception $e) {
        // Expected
    }
    $result = handle('user1', 'key1', 'POST', '/resource', '{}', $operation);
    expectTrue($called === 2, 'Operation should be called twice');
    expectEquals(200, $result['status'], 'Status should be 200');
    expectEquals('application/json', $result['content_type'], 'Content type should be application/json');
}

function test_error_responses_have_correct_content_type_and_body() {
    resetGlobals();
    $result = handle('user1', '', 'POST', '/resource', '{}', function() {
        return ['status' => 200, 'body' => []];
    });
    expectEquals('application/problem+json', $result['content_type'], '400 content type should be application/problem+json');
    $body = json_decode($result['body'], true);
    expectTrue(isset($body['type']), 'Body should have type');
    expectTrue(isset($body['title']), 'Body should have title');
    expectTrue(isset($body['detail']), 'Body should have detail');

    resetGlobals();
    $storage = $GLOBALS['IDEM_POTENCY_STORAGE'];
    $now = time();
    $ttl = IDEMPOTENCY_TTL;
    $fingerprint = hash('sha256', 'POST /resource\n{}');
    $storage->claimKey('user1', 'key1', $fingerprint, $now, $ttl);
    $result = handle('user1', 'key1', 'POST', '/resource', '{}', function() {
        return ['status' => 200, 'body' => []];
    });
    expectEquals('application/problem+json', $result['content_type'], '409 content type should be application/problem+json');
    $body = json_decode($result['body'], true);
    expectTrue(isset($body['type']), 'Body should have type');
    expectTrue(isset($body['title']), 'Body should have title');
    expectTrue(isset($body['detail']), 'Body should have detail');

    resetGlobals();
    $called = 0;
    $operation = function() use (&$called) {
        $called++;
        return ['status' => 200, 'body' => ['result' => 'success']];
    };
    handle('user1', 'key1', 'POST', '/resource', '{"a":1}', $operation);
    $result = handle('user1', 'key1', 'POST', '/resource', '{"a":2}', $operation);
    expectEquals('application/problem+json', $result['content_type'], '422 content type should be application/problem+json');
    $body = json_decode($result['body'], true);
    expectTrue(isset($body['type']), 'Body should have type');
    expectTrue(isset($body['title']), 'Body should have title');
    expectTrue(isset($body['detail']), 'Body should have detail');
}

$tests = [
    'test_first_call_runs_operation_once',
    'test_second_identical_call_returns_stored_response',
    'test_same_key_different_body_returns_422',
    'test_same_key_in_progress_returns_409',
    'test_required_operation_no_key_returns_400',
    'test_same_key_different_scope_runs_twice',
    'test_expired_key_runs_operation_again',
    'test_operation_that_raises_frees_the_key',
    'test_error_responses_have_correct_content_type_and_body'
];

$failed = [];
foreach ($tests as $test) {
    try {
        $test();
        echo "PASS: $test\n";
    } catch (Exception $e) {
        echo "FAIL: $test - {$e->getMessage()}\n";
        $failed[] = $test;
    }
}

if (!empty($failed)) {
    echo "Failed tests: " . implode(', ', $failed) . "\n";
    exit(1);
}
echo "All tests passed\n";
exit(0);
?>