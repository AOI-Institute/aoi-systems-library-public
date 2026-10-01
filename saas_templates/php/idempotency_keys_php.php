<?php

interface IdempotencyStorage {
    public function claimKey(string $scope, string $idemKey, string $fingerprint, int $now, int $ttl): bool;
    public function getRecord(string $scope, string $idemKey, int $now): ?array;
    public function storeResponse(string $scope, string $idemKey, string $fingerprint, int $status, string $body, int $createdAt, int $expiresAt): void;
    public function deleteRecord(string $scope, string $idemKey): void;
    public function insertRecord(string $scope, string $idemKey, string $fingerprint, string $status, ?int $responseStatus, ?string $responseBody, int $createdAt, int $expiresAt): void;
    public function purgeExpired(int $now): void;
}

class InMemoryStorage implements IdempotencyStorage {
    private array $records = [];

    public function claimKey(string $scope, string $idemKey, string $fingerprint, int $now, int $ttl): bool {
        $key = $scope . '|' . $idemKey;
        if (isset($this->records[$key])) {
            $record = $this->records[$key];
            if ($record['expires_at'] <= $now) {
                unset($this->records[$key]);
            } else {
                return false;
            }
        }
        $this->records[$key] = [
            'scope' => $scope,
            'idem_key' => $idemKey,
            'request_fingerprint' => $fingerprint,
            'status' => 'in_progress',
            'response_status' => null,
            'response_body' => null,
            'created_at' => $now,
            'expires_at' => $now + $ttl
        ];
        return true;
    }

    public function getRecord(string $scope, string $idemKey, int $now): ?array {
        $key = $scope . '|' . $idemKey;
        if (!isset($this->records[$key])) {
            return null;
        }
        $record = $this->records[$key];
        if ($record['expires_at'] <= $now) {
            unset($this->records[$key]);
            return null;
        }
        return $record;
    }

    public function storeResponse(string $scope, string $idemKey, string $fingerprint, int $status, string $body, int $createdAt, int $expiresAt): void {
        $key = $scope . '|' . $idemKey;
        if (isset($this->records[$key])) {
            $this->records[$key]['status'] = 'completed';
            $this->records[$key]['response_status'] = $status;
            $this->records[$key]['response_body'] = $body;
            $this->records[$key]['created_at'] = $createdAt;
            $this->records[$key]['expires_at'] = $expiresAt;
        }
    }

    public function deleteRecord(string $scope, string $idemKey): void {
        $key = $scope . '|' . $idemKey;
        unset($this->records[$key]);
    }

    public function insertRecord(string $scope, string $idemKey, string $fingerprint, string $status, ?int $responseStatus, ?string $responseBody, int $createdAt, int $expiresAt): void {
        $key = $scope . '|' . $idemKey;
        $this->records[$key] = [
            'scope' => $scope,
            'idem_key' => $idemKey,
            'request_fingerprint' => $fingerprint,
            'status' => $status,
            'response_status' => $responseStatus,
            'response_body' => $responseBody,
            'created_at' => $createdAt,
            'expires_at' => $expiresAt
        ];
    }

    public function purgeExpired(int $now): void {
        foreach ($this->records as $key => $record) {
            if ($record['expires_at'] <= $now) {
                unset($this->records[$key]);
            }
        }
    }
}

class SqlIdempotencyStorage implements IdempotencyStorage {
    private \PDO $pdo;

    public function __construct(\PDO $pdo) {
        $this->pdo = $pdo;
    }

    public function claimKey(string $scope, string $idemKey, string $fingerprint, int $now, int $ttl): bool {
        try {
            $stmt = $this->pdo->prepare("INSERT INTO idempotency_records (scope, idem_key, request_fingerprint, status, response_status, response_body, created_at, expires_at) VALUES (?, ?, ?, 'in_progress', NULL, NULL, ?, ?)");
            $stmt->execute([$scope, $idemKey, $fingerprint, $now, $now + $ttl]);
            return true;
        } catch (\PDOException $e) {
            if ($e->getCode() === '23000') {
                $this->deleteExpired($scope, $idemKey, $now);
                $stmt = $this->pdo->prepare("INSERT INTO idempotency_records (scope, idem_key, request_fingerprint, status, response_status, response_body, created_at, expires_at) VALUES (?, ?, ?, 'in_progress', NULL, NULL, ?, ?)");
                $stmt->execute([$scope, $idemKey, $fingerprint, $now, $now + $ttl]);
                return true;
            }
            throw $e;
        }
    }

    private function deleteExpired(string $scope, string $idemKey, int $now): void {
        $stmt = $this->pdo->prepare("DELETE FROM idempotency_records WHERE scope = ? AND idem_key = ? AND expires_at <= ?");
        $stmt->execute([$scope, $idemKey, $now]);
    }

    public function getRecord(string $scope, string $idemKey, int $now): ?array {
        $stmt = $this->pdo->prepare("SELECT * FROM idempotency_records WHERE scope = ? AND idem_key = ? AND expires_at > ?");
        $stmt->execute([$scope, $idemKey, $now]);
        $record = $stmt->fetch(\PDO::FETCH_ASSOC);
        return $record ?: null;
    }

    public function storeResponse(string $scope, string $idemKey, string $fingerprint, int $status, string $body, int $createdAt, int $expiresAt): void {
        $stmt = $this->pdo->prepare("UPDATE idempotency_records SET status = 'completed', response_status = ?, response_body = ?, created_at = ?, expires_at = ? WHERE scope = ? AND idem_key = ?");
        $stmt->execute([$status, $body, $createdAt, $expiresAt, $scope, $idemKey]);
    }

    public function deleteRecord(string $scope, string $idemKey): void {
        $stmt = $this->pdo->prepare("DELETE FROM idempotency_records WHERE scope = ? AND idem_key = ?");
        $stmt->execute([$scope, $idemKey]);
    }

    public function insertRecord(string $scope, string $idemKey, string $fingerprint, string $status, ?int $responseStatus, ?string $responseBody, int $createdAt, int $expiresAt): void {
        $stmt = $this->pdo->prepare("INSERT INTO idempotency_records (scope, idem_key, request_fingerprint, status, response_status, response_body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        $stmt->execute([$scope, $idemKey, $fingerprint, $status, $responseStatus, $responseBody, $createdAt, $expiresAt]);
    }

    public function purgeExpired(int $now): void {
        $stmt = $this->pdo->prepare("DELETE FROM idempotency_records WHERE expires_at <= ?");
        $stmt->execute([$now]);
    }
}

const IDEMPOTENCY_TTL = 86400;

$GLOBALS['IDEM_POTENCY_STORAGE'] = new InMemoryStorage();
$GLOBALS['IDEMPOTENCY_REQUIRED_METHODS'] = ['POST', 'PATCH'];

function is_required(string $method, string $path): bool {
    return in_array(strtoupper($method), $GLOBALS['IDEMPOTENCY_REQUIRED_METHODS']);
}

function compute_fingerprint(string $method, string $path, string $body): string {
    return hash('sha256', $method . ' ' . $path . "\n" . $body);
}

function handle(string $scope, string $idempotencyKey, string $method, string $path, string $body, callable $operation): array {
    $now = time();
    $ttl = IDEMPOTENCY_TTL;
    $storage = $GLOBALS['IDEM_POTENCY_STORAGE'];

    if (is_required($method, $path) && empty($idempotencyKey)) {
        return [
            'status' => 400,
            'content_type' => 'application/problem+json',
            'body' => json_encode([
                'type' => 'https://example.com/problems/missing-idempotency-key',
                'title' => 'Missing Idempotency Key',
                'detail' => 'The Idempotency-Key header is required for this operation.'
            ])
        ];
    }

    if (!is_required($method, $path)) {
        $result = $operation();
        return [
            'status' => $result['status'],
            'content_type' => 'application/json',
            'body' => json_encode($result['body'])
        ];
    }

    $fingerprint = compute_fingerprint($method, $path, $body);
    $record = $storage->getRecord($scope, $idempotencyKey, $now);

    if ($record !== null) {
        if ($record['status'] === 'in_progress') {
            return [
                'status' => 409,
                'content_type' => 'application/problem+json',
                'body' => json_encode([
                    'type' => 'https://example.com/problems/conflict',
                    'title' => 'Conflict',
                    'detail' => 'An operation with this idempotency key is already in progress.'
                ])
            ];
        }

        if ($record['request_fingerprint'] !== $fingerprint) {
            return [
                'status' => 422,
                'content_type' => 'application/problem+json',
                'body' => json_encode([
                    'type' => 'https://example.com/problems/payload-mismatch',
                    'title' => 'Payload Mismatch',
                    'detail' => 'The request payload does not match the original request for this idempotency key.'
                ])
            ];
        }

        return [
            'status' => $record['response_status'],
            'content_type' => 'application/json',
            'body' => $record['response_body']
        ];
    }

    if (!$storage->claimKey($scope, $idempotencyKey, $fingerprint, $now, $ttl)) {
        return [
            'status' => 409,
            'content_type' => 'application/problem+json',
            'body' => json_encode([
                'type' => 'https://example.com/problems/conflict',
                'title' => 'Conflict',
                'detail' => 'An operation with this idempotency key is already in progress.'
            ])
        ];
    }

    try {
        $result = $operation();
        $responseBody = json_encode($result['body']);
        $storage->storeResponse($scope, $idempotencyKey, $fingerprint, $result['status'], $responseBody, $now, $now + $ttl);
        return [
            'status' => $result['status'],
            'content_type' => 'application/json',
            'body' => $responseBody
        ];
    } catch (\Throwable $e) {
        $storage->deleteRecord($scope, $idempotencyKey);
        throw $e;
    }
}

function purge_expired(): void {
    $GLOBALS['IDEM_POTENCY_STORAGE']->purgeExpired(time());
}
?>