<?php

require_once 'api_keys_service_accounts_php.php';

class ApiKeyServiceTest {
    private PDO $pdo;
    private InMemoryRateLimiter $rateLimiter;
    private ApiKeyService $service;

    public function setUp(): void {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->rateLimiter = new InMemoryRateLimiter();
        $this->service = new ApiKeyService($this->pdo, $this->rateLimiter);
    }

    public function run(): void {
        $tests = [
            'testCreateKeyWithScopes',
            'testUseKeySuccess',
            'testRevokeKey',
            'testRateLimitExceeded',
            'testScopeCheckFailure',
            'testRotateKeyGracePeriod',
            'testExpiredKey',
            'testUsageStats',
            'testAdminAudit'
        ];

        $passed = 0;
        $failed = 0;

        foreach ($tests as $test) {
            $this->setUp();
            try {
                $this->$test();
                echo "✓ {$test} passed\n";
                $passed++;
            } catch (Throwable $e) {
                echo "✗ {$test} failed: " . $e->getMessage() . "\n";
                echo $e->getTraceAsString() . "\n";
                $failed++;
            }
        }

        echo "\nTotal: " . ($passed + $failed) . " | Passed: {$passed} | Failed: {$failed}\n";
        exit($failed > 0 ? 1 : 0);
    }

    private function assert(bool $condition, string $message = 'Assertion failed'): void {
        if (!$condition) {
            throw new Exception($message);
        }
    }

    public function testCreateKeyWithScopes(): void {
        $res = $this->service->createApiKey(1, 'My Integration', ['read:deployments', 'write:webhooks'], '2026-12-31', 1000);
        
        $this->assert(isset($res['api_key_id']), 'Should return api_key_id');
        $this->assert(strpos($res['key'], 'sk_live_') === 0, 'Should start with sk_live_');
        $this->assert($res['rate_limit'] === 1000, 'Should match rate limit');
        $this->assert($res['expires_at'] === '2026-12-31', 'Should match expires_at');
    }

    public function testUseKeySuccess(): void {
        $res = $this->service->createApiKey(1, 'My Integration', ['read:deployments'], null, 1000);
        $rawKey = $res['key'];

        $auth = $this->service->authenticateAndValidate($rawKey, 'GET', '/deployments');
        $this->assert($auth['valid'] === true, 'Authentication should succeed');
        $this->assert($auth['user_id'] === 1, 'User ID should match');
    }

    public function testRevokeKey(): void {
        $res = $this->service->createApiKey(1, 'My Integration', ['read:deployments'], null, 1000);
        $rawKey = $res['key'];
        $keyId = $res['api_key_id'];

        $revokeRes = $this->service->revokeApiKey($keyId);
        $this->assert($revokeRes['success'] === true, 'Revocation should succeed');

        $auth = $this->service->authenticateAndValidate($rawKey, 'GET', '/deployments');
        $this->assert($auth['valid'] === false, 'Authentication should fail after revocation');
        $this->assert($auth['status'] === 401, 'Status should be 401');
    }

    public function testRateLimitExceeded(): void {
        $res = $this->service->createApiKey(1, 'My Integration', ['read:deployments'], null, 3);
        $rawKey = $res['key'];

        for ($i = 0; $i < 3; $i++) {
            $auth = $this->service->authenticateAndValidate($rawKey, 'GET', '/deployments');
            $this->assert($auth['valid'] === true, "Request {$i} should succeed");
        }

        $auth = $this->service->authenticateAndValidate($rawKey, 'GET', '/deployments');
        $this->assert($auth['valid'] === false, '4th request should be rate limited');
        $this->assert($auth['status'] === 429, 'Status should be 429');
    }

    public function testScopeCheckFailure(): void {
        $res = $this->service->createApiKey(1, 'My Integration', ['read:deployments'], null, 1000);
        $rawKey = $res['key'];

        $auth = $this->service->authenticateAndValidate($rawKey, 'POST', '/deployments');
        $this->assert($auth['valid'] === false, 'Should fail scope check');
        $this->assert($auth['status'] === 403, 'Status should be 403');
    }

    public function testRotateKeyGracePeriod(): void {
        $res = $this->service->createApiKey(1, 'My Integration', ['read:deployments'], null, 1000);
        $oldKey = $res['key'];
        $oldKeyId = $res['api_key_id'];

        $rotation = $this->service->rotateApiKey($oldKeyId);
        $newKey = $rotation['new_key'];

        $authOld = $this->service->authenticateAndValidate($oldKey, 'GET', '/deployments');
        $this->assert($authOld['valid'] === true, 'Old key should still work during grace period');

        $authNew = $this->service->authenticateAndValidate($newKey, 'GET', '/deployments');
        $this->assert($authNew['valid'] === true, 'New key should work immediately');

        $stmt = $this->pdo->prepare("UPDATE api_keys SET grace_expires_at = :past WHERE id = :id");
        $stmt->execute([
            ':past' => date('Y-m-d H:i:s', time() - 3600),
            ':id' => $oldKeyId
        ]);

        $authOldExpired = $this->service->authenticateAndValidate($oldKey, 'GET', '/deployments');
        $this->assert($authOldExpired['valid'] === false, 'Old key should fail after grace period expires');
    }

    public function testExpiredKey(): void {
        $pastDate = date('Y-m-d H:i:s', time() - 3600);
        $res = $this->service->createApiKey(1, 'My Integration', ['read:deployments'], $pastDate, 1000);
        $rawKey = $res['key'];

        $auth = $this->service->authenticateAndValidate($rawKey, 'GET', '/deployments');
        $this->assert($auth['valid'] === false, 'Expired key should fail authentication');
        $this->assert($auth['status'] === 401, 'Status should be 401');
    }

    public function testUsageStats(): void {
        $res = $this->service->createApiKey(1, 'My Integration', ['read:deployments', 'write:billing'], null, 1000);
        $rawKey = $res['key'];
        $keyId = $res['api_key_id'];

        $this->service->authenticateAndValidate($rawKey, 'GET', '/deployments');
        $this->service->authenticateAndValidate($rawKey, 'POST', '/billing');
        $this->service->authenticateAndValidate($rawKey, 'DELETE', '/deployments'); // 403

        $from = date('Y-m-d H:i:s', time() - 3600);
        $to = date('Y-m-d H:i:s', time() + 3600);

        $stats = $this->service->getApiKeyUsageStats($keyId, $from, $to);

        $this->assert($stats['total_requests'] === 3, 'Should record 3 requests');
        $this->assert($stats['requests_by_endpoint']['GET /deployments'] === 1, 'Should record 1 GET /deployments');
        $this->assert($stats['requests_by_endpoint']['POST /billing'] === 1, 'Should record 1 POST /billing');
        $this->assert($stats['errors']['403'] === 1, 'Should record 1 403 error');
    }

    public function testAdminAudit(): void {
        $this->service->createApiKey(1, 'Key 1', ['*'], null, 1000);
        $this->service->createApiKey(1, 'Key 2', ['read:users'], null, 1000);
        $this->service->createApiKey(2, 'Key 3', ['write:users'], null, 1000);

        $auditAll = $this->service->adminListAllKeys();
        $this->assert($auditAll['total'] === 3, 'Admin should see all 3 keys');

        $auditUser1 = $this->service->adminListAllKeys(1);
        $this->assert($auditUser1['total'] === 2, 'Admin should see 2 keys for user 1');

        $auditActive = $this->service->adminListAllKeys(null, 'active');
        $this->assert($auditActive['total'] === 3, 'All keys should be active');
    }
}

$testRunner = new ApiKeyServiceTest();
$testRunner->run();