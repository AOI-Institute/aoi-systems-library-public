<?php
declare(strict_types=1);

/**
 * Background Jobs & Task Queue Implementation
 * Provides HTTP API endpoints for job management and processing.
 */

use PDO;
use PDOException;

/**
 * Generates a UUID v4 string.
 * @return string
 */
function generateUuid(): string
{
    $data = random_bytes(16);
    $data[6] = chr(ord($data[6]) & 0x0f | 0x40); // Set version to 4
    $data[8] = chr(ord($data[8]) & 0x3f | 0x80); // Set bits 6-7 to 10
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}

/**
 * JobQueue class handles job lifecycle and processing.
 */
class JobQueue
{
    private PDO $pdo;
    private array $taskHandlers = [];

    public function __construct(PDO $pdo)
    {
        $this->pdo = $pdo;
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->registerTaskHandlers();
    }

    private function registerTaskHandlers(): void
    {
        $this->taskHandlers = [
            'send_bulk_email' => [$this, 'handleSendBulkEmail'],
            'webhook_retry' => [$this, 'handleWebhookRetry'],
            'export_generate' => [$this, 'handleExportGenerate'],
            'daily_report_generate' => [$this, 'handleDailyReportGenerate'],
            'cleanup_old_sessions' => [$this, 'handleCleanupOldSessions'],
            'delete_user_cascade' => [$this, 'handleDeleteUserCascade'],
        ];
    }

    /**
     * Enqueues a new job.
     * @param array $data {task_type, params, scheduled_at?, max_retries?}
     * @return array {success: true, job_id, status: 'enqueued'}
     * @throws InvalidArgumentException
     */
    public function enqueue(array $data): array
    {
        if (!isset($data['task_type']) || !is_string($data['task_type'])) {
            throw new InvalidArgumentException('task_type is required and must be a string');
        }
        if (!isset($data['params']) || !is_array($data['params'])) {
            throw new InvalidArgumentException('params is required and must be an array');
        }

        $jobId = generateUuid();
        $taskType = $data['task_type'];
        $params = json_encode($data['params'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $scheduledAt = isset($data['scheduled_at']) ? $data['scheduled_at'] : null;
        $maxRetries = isset($data['max_retries']) ? (int)$data['max_retries'] : 3;

        $this->pdo->beginTransaction();
        try {
            $stmt = $this->pdo->prepare(
                "INSERT INTO jobs (id, task_type, params, status, max_retries, scheduled_at)
                 VALUES (:id, :task_type, :params, 'enqueued', :max_retries, :scheduled_at)"
            );
            $stmt->execute([
                'id' => $jobId,
                'task_type' => $taskType,
                'params' => $params,
                'max_retries' => $maxRetries,
                'scheduled_at' => $scheduledAt
            ]);
            $this->pdo->commit();
        } catch (PDOException $e) {
            $this->pdo->rollBack();
            throw $e;
        }

        return [
            'success' => true,
            'job_id' => $jobId,
            'status' => 'enqueued'
        ];
    }

    /**
     * Gets job status and details.
     * @param string $jobId
     * @return array {job_id, task_type, status, progress, created_at, started_at, result, next_retry_at}
     * @throws NotFoundException
     */
    public function getStatus(string $jobId): array
    {
        $job = $this->getJob($jobId);
        $result = [
            'job_id' => $job['id'],
            'task_type' => $job['task_type'],
            'status' => $job['status'],
            'progress' => $job['progress'],
            'created_at' => $job['created_at'],
            'started_at' => $job['started_at'],
            'result' => $job['result'] ? json_decode($job['result'], true) : null,
            'next_retry_at' => $job['next_retry_at']
        ];
        return $result;
    }

    /**
     * Lists jobs with optional filters.
     * @param array $filters {status?, task_type?, limit?}
     * @return array {jobs: array, total: int}
     */
    public function listJobs(array $filters = []): array
    {
        $where = [];
        $params = [];

        if (isset($filters['status'])) {
            $where[] = 'status = :status';
            $params[':status'] = $filters['status'];
        }
        if (isset($filters['task_type'])) {
            $where[] = 'task_type = :task_type';
            $params[':task_type'] = $filters['task_type'];
        }

        $whereClause = $where ? 'WHERE ' . implode(' AND ', $where) : '';
        $limitClause = isset($filters['limit']) ? 'LIMIT :limit' : '';
        if (isset($filters['limit'])) {
            $params[':limit'] = (int)$filters['limit'];
        }

        $stmt = $this->pdo->prepare(
            "SELECT SQL_CALC_FOUND_ROWS id, task_type, status, progress, created_at, started_at, completed_at, result, next_retry_at
             FROM jobs
             $whereClause
             ORDER BY created_at DESC
             $limitClause"
        );
        $stmt->execute($params);
        $jobs = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $totalStmt = $this->pdo->query('SELECT FOUND_ROWS() as total');
        $total = (int)$totalStmt->fetchColumn();

        foreach ($jobs as &$job) {
            $job['result'] = $job['result'] ? json_decode($job['result'], true) : null;
        }

        return [
            'jobs' => $jobs,
            'total' => $total
        ];
    }

    /**
     * Cancels a job if not started.
     * @param string $jobId
     * @return array {success: true, status: 'cancelled'}
     * @throws InvalidArgumentException
     * @throws NotFoundException
     */
    public function cancelJob(string $jobId): array
    {
        $job = $this->getJob($jobId);
        if ($job['status'] !== 'enqueued') {
            throw new InvalidArgumentException('Job can only be cancelled if not started');
        }

        $this->pdo->beginTransaction();
        try {
            $stmt = $this->pdo->prepare(
                "UPDATE jobs SET status = 'cancelled' WHERE id = :id"
            );
            $stmt->execute([':id' => $jobId]);
            $this->pdo->commit();
        } catch (PDOException $e) {
            $this->pdo->rollBack();
            throw $e;
        }

        return [
            'success' => true,
            'status' => 'cancelled'
        ];
    }

    /**
     * Retries a failed job.
     * @param string $jobId
     * @return array {success: true, new_job_id, status: 'enqueued'}
     * @throws InvalidArgumentException
     * @throws NotFoundException
     */
    public function retryJob(string $jobId): array
    {
        $job = $this->getJob($jobId);
        if ($job['status'] !== 'failed') {
            throw new InvalidArgumentException('Only failed jobs can be retried');
        }
        if ($job['retry_count'] >= $job['max_retries']) {
            throw new InvalidArgumentException('Job has exceeded max retries');
        }

        $newJobId = generateUuid();
        $nextRetryAt = (new DateTimeImmutable())->modify(
            sprintf('+%d seconds', pow(2, $job['retry_count']))
        )->format('Y-m-d H:i:s');

        $this->pdo->beginTransaction();
        try {
            // Create new job
            $stmt = $this->pdo->prepare(
                "INSERT INTO jobs (id, task_type, params, status, max_retries, retry_count, next_retry_at, scheduled_at)
                 VALUES (:id, :task_type, :params, 'enqueued', :max_retries, :retry_count, :next_retry_at, :scheduled_at)"
            );
            $stmt->execute([
                'id' => $newJobId,
                'task_type' => $job['task_type'],
                'params' => $job['params'],
                'max_retries' => $job['max_retries'],
                'retry_count' => $job['retry_count'] + 1,
                'next_retry_at' => $nextRetryAt,
                'scheduled_at' => $job['scheduled_at']
            ]);

            // Update original job to reference retry? (Optional, not in spec)
            // We'll just leave it as failed.

            $this->pdo->commit();
        } catch (PDOException $e) {
            $this->pdo->rollBack();
            throw $e;
        }

        return [
            'success' => true,
            'new_job_id' => $newJobId,
            'status' => 'enqueued'
        ];
    }

    /**
     * Gets job results when completed.
     * @param string $jobId
     * @return array {job_id, status, result, completed_at}
     * @throws InvalidArgumentException
     * @throws NotFoundException
     */
    public function getResults(string $jobId): array
    {
        $job = $this->getJob($jobId);
        if ($job['status'] !== 'completed') {
            throw new InvalidArgumentException('Results are only available for completed jobs');
        }

        return [
            'job_id' => $job['id'],
            'status' => $job['status'],
            'result' => $job['result'] ? json_decode($job['result'], true) : null,
            'completed_at' => $job['completed_at']
        ];
    }

    /**
     * Processes a single job (called by worker).
     * @param string $jobId
     * @throws NotFoundException
     * @throws InvalidArgumentException
     */
    public function processJob(string $jobId): void
    {
        $job = $this->getJob($jobId);
        if ($job['status'] !== 'enqueued') {
            throw new InvalidArgumentException('Job is not enqueued');
        }
        if ($job['scheduled_at'] && (new DateTimeImmutable()) < new DateTimeImmutable($job['scheduled_at'])) {
            return; // Not yet scheduled
        }

        $this->pdo->beginTransaction();
        try {
            // Mark job as running
            $stmt = $this->pdo->prepare(
                "UPDATE jobs SET status = 'running', started_at = NOW() WHERE id = :id"
            );
            $stmt->execute([':id' => $jobId]);

            // Get lock on job row to prevent concurrent processing
            $lockStmt = $this->pdo->prepare(
                "SELECT id FROM jobs WHERE id = :id FOR UPDATE"
            );
            $lockStmt->execute([':id' => $jobId]);
            $lockStmt->fetch();

            // Parse params
            $params = json_decode($job['params'], true);
            if (json_last_error() !== JSON_ERROR_NONE) {
                throw new RuntimeException('Invalid job params JSON');
            }

            // Execute task handler
            if (!isset($this->taskHandlers[$job['task_type']])) {
                throw new InvalidArgumentException(sprintf('Unknown task type: %s', $job['task_type']));
            }

            $handler = $this->taskHandlers[$job['task_type']];
            $result = $handler($params, function ($current, $total) use ($jobId) {
                $this->updateProgress($jobId, $current, $total);
            });

            // Update job as completed
            $stmt = $this->pdo->prepare(
                "UPDATE jobs SET status = 'completed', completed_at = NOW(), result = :result, progress = :progress
                 WHERE id = :id"
            );
            $stmt->execute([
                ':id' => $jobId,
                ':result' => json_encode($result),
                ':progress' => sprintf('%d/%d', $result['total'] ?? 0, $result['total'] ?? 0)
            ]);

            // Create job run record
            $runId = generateUuid();
            $stmt = $this->pdo->prepare(
                "INSERT INTO job_runs (id, job_id, status, started_at, completed_at, result)
                 VALUES (:id, :job_id, 'completed', NOW(), NOW(), :result)"
            );
            $stmt->execute([
                ':id' => $runId,
                ':job_id' => $jobId,
                ':result' => json_encode($result)
            ]);

            $this->pdo->commit();
        } catch (Throwable $e) {
            $this->pdo->rollBack();
            $this->handleJobFailure($jobId, $e);
        }
    }

    private function handleJobFailure(string $jobId, Throwable $e): void
    {
        $job = $this->getJob($jobId);
        $retryCount = $job['retry_count'] + 1;
        $maxRetries = $job['max_retries'];

        $update = [
            'status' => $retryCount >= $maxRetries ? 'failed' : 'enqueued',
            'retry_count' => $retryCount,
            'error' => $e->getMessage()
        ];

        if ($retryCount < $maxRetries) {
            $nextRetryAt = (new DateTimeImmutable())->modify(
                sprintf('+%d seconds', pow(2, $retryCount - 1))
            )->format('Y-m-d H:i:s');
            $update['next_retry_at'] = $nextRetryAt;
        } else {
            $update['next_retry_at'] = null;
            $update['completed_at'] = new DateTimeImmutable();
        }

        $this->pdo->beginTransaction();
        try {
            $setClause = [];
            $params = [':id' => $jobId];
            foreach ($update as $key => $value) {
                $setClause[] = "$key = :$key";
                $params[":$key"] = $value;
            }
            $stmt = $this->pdo->prepare(
                "UPDATE jobs SET " . implode(', ', $setClause) . " WHERE id = :id"
            );
            $stmt->execute($params);

            // Create job run record for failed attempt
            $runId = generateUuid();
            $stmt = $this->pdo->prepare(
                "INSERT INTO job_runs (id, job_id, status, started_at, completed_at, result)
                 VALUES (:id, :job_id, 'failed', NOW(), NOW(), :result)"
            );
            $stmt->execute([
                ':id' => $runId,
                ':job_id' => $jobId,
                ':result' => json_encode(['error' => $e->getMessage()])
            ]);

            $this->pdo->commit();
        } catch (PDOException $ex) {
            $this->pdo->rollBack();
            throw $ex;
        }
    }

    private function updateProgress(string $jobId, int $current, int $total): void
    {
        $stmt = $this->pdo->prepare(
            "UPDATE jobs SET progress = :progress WHERE id = :id"
        );
        $stmt->execute([
            ':progress' => sprintf('%d/%d', $current, $total),
            ':id' => $jobId
        ]);
    }

    private function getJob(string $jobId): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT id, task_type, params, status, created_at, started_at, completed_at,
                    progress, result, error, retry_count, max_retries, next_retry_at, scheduled_at
             FROM jobs WHERE id = :id"
        );
        $stmt->execute([':id' => $jobId]);
        $job = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$job) {
            throw new NotFoundException(sprintf('Job not found: %s', $jobId));
        }
        $job['params'] = json_decode($job['params'], true);
        return $job;
    }

    // Task Handlers (Simulated implementations)

    private function handleSendBulkEmail(array $params, callable $progressCallback): array
    {
        $total = $params['total'] ?? 10;
        $failurePoints = $params['failure_points'] ?? [];
        $sent = 0;
        $failed = 0;
        $errors = [];

        for ($i = 0; $i < $total; $i++) {
            $progressCallback($i + 1, $total);
            if (in_array($i, $failurePoints)) {
                $failed++;
                $errors[] = [
                    'user_id' => 1000 + $i,
                    'error' => 'email_bounced'
                ];
            } else {
                $sent++;
            }
            // Simulate work (remove in production)
            usleep(1000);
        }

        return [
            'task_type' => 'send_bulk_email',
            'sent' => $sent,
            'failed' => $failed,
            'skipped' => 0,
            'errors' => $errors
        ];
    }

    private function handleWebhookRetry(array $params, callable $progressCallback): array
    {
        $total = $params['total'] ?? 10;
        $failurePoints = $params['failure_points'] ?? [];
        $success = 0;
        $failed = 0;
        $errors = [];

        for ($i = 0; $i < $total; $i++) {
            $progressCallback($i + 1, $total);
            if (in_array($i, $failurePoints)) {
                $failed++;
                $errors[] = [
                    'webhook_id' => 'wh_' . (2000 + $i),
                    'error' => 'timeout'
                ];
            } else {
                $success++;
            }
            usleep(1000);
        }

        return [
            'task_type' => 'webhook_retry',
            'success' => $success,
            'failed' => $failed,
            'errors' => $errors
        ];
    }

    private function handleExportGenerate(array $params, callable $progressCallback): array
    {
        $total = $params['total'] ?? 1000;
        $format = $params['format'] ?? 'csv';
        $processed = 0;

        for ($i = 0; $i < $total; $i++) {
            $progressCallback($i + 1, $total);
            $processed++;
            usleep(500);
        }

        return [
            'task_type' => 'export_generate',
            'format' => $format,
            'size_bytes' => $processed * 100,
            'rows' => $processed
        ];
    }

    private function handleDailyReportGenerate(array $params, callable $progressCallback): array
    {
        $total = $params['metrics'] ?? 50;
        $processed = 0;

        for ($i = 0; $i < $total; $i++) {
            $progressCallback($i + 1, $total);
            $processed++;
            usleep(200);
        }

        return [
            'task_type' => 'daily_report_generate',
            'date' => (new DateTimeImmutable())->format('Y-m-d'),
            'metrics_processed' => $processed,
            'data_points' => $processed * 10
        ];
    }

    private function handleCleanupOldSessions(array $params, callable $progressCallback): array
    {
        $total = $params['session_count'] ?? 1000;
        $deleted = 0;

        for ($i = 0; $i < $total; $i++) {
            $progressCallback($i + 1, $total);
            // Simulate session deletion
            $deleted++;
            usleep(200);
        }

        return [
            'task_type' => 'cleanup_old_sessions',
            'deleted_sessions' => $deleted,
            'freed_space_mb' => $deleted * 0.5
        ];
    }

    private function handleDeleteUserCascade(array $params, callable $progressCallback): array
    {
        $total = $params['total_items'] ?? 6; // 1 user + 5 related
        $deleted = 0;

        for ($i = 0; $i < $total; $i++) {
            $progressCallback($i + 1, $total);
            $deleted++;
            usleep(300);
        }

        return [
            'task_type' => 'delete_user_cascade',
            'user_id' => $params['user_id'] ?? 0,
            'related_records_deleted' => $deleted - 1,
            'total_deleted' => $deleted
        ];
    }
}

/**
 * Handles HTTP requests and routes to JobQueue methods.
 * @param string $method
 * @param string $uri
 * @param array $headers
 * @param string $body
 * @return array {status: string, headers: array, body: string}
 */
function handleRequest(string $method, string $uri, array $headers, string $body): array
{
    // Parse URI and query string
    $parts = explode('?', $uri, 2);
    $path = $parts[0];
    $query = isset($parts[1]) ? $parts[1] : '';
    parse_str($query, $queryParams);

    // Initialize JobQueue (in real app, DI container would be used)
    static $jobQueue = null;
    if ($jobQueue === null) {
        $dbHost = getenv('DB_HOST') ?: 'localhost';
        $dbName = getenv('DB_NAME') ?: 'jobs';
        $dbUser = getenv('DB_USER') ?: 'root';
        $dbPass = getenv('DB_PASS') ?: '';
        $dsn = sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', $dbHost, $dbName);
        $pdo = new PDO($dsn, $dbUser, $dbPass);
        $jobQueue = new JobQueue($pdo);
    }

    try {
        switch ($method) {
            case 'POST':
                if (preg_match('#^/jobs/enqueue$#', $path)) {
                    $data = json_decode($body, true);
                    if (json_last_error() !== JSON_ERROR_NONE) {
                        throw new InvalidArgumentException('Invalid JSON');
                    }
                    $result = $jobQueue->enqueue($data);
                    return [
                        'status' => '200 OK',
                        'headers' => ['Content-Type' => 'application/json'],
                        'body' => json_encode($result)
                    ];
                }
                if (preg_match('#^/jobs/([^/]+)/retry$#', $path, $matches)) {
                    $result = $jobQueue->retryJob($matches[1]);
                    return [
                        'status' => '200 OK',
                        'headers' => ['Content-Type' => 'application/json'],
                        'body' => json_encode($result)
                    ];
                }
                break;

            case 'GET':
                if (preg_match('#^/jobs/([^/]+)$#', $path, $matches)) {
                    $result = $jobQueue->getStatus($matches[1]);
                    return [
                        'status' => '200 OK',
                        'headers' => ['Content-Type' => 'application/json'],
                        'body' => json_encode($result)
                    ];
                }
                if (preg_match('#^/jobs/([^/]+)/results$#', $path, $matches)) {
                    $result = $jobQueue->getResults($matches[1]);
                    return [
                        'status' => '200 OK',
                        'headers' => ['Content-Type' => 'application/json'],
                        'body' => json_encode($result)
                    ];
                }
                if ($path === '/jobs') {
                    $filters = [];
                    if (isset($queryParams['status'])) {
                        $filters['status'] = $queryParams['status'];
                    }
                    if (isset($queryParams['task_type'])) {
                        $filters['task_type'] = $queryParams['task_type'];
                    }
                    if (isset($queryParams['limit'])) {
                        $filters['limit'] = (int)$queryParams['limit'];
                    }
                    $result = $jobQueue->listJobs($filters);
                    return [
                        'status' => '200 OK',
                        'headers' => ['Content-Type' => 'application/json'],
                        'body' => json_encode($result)
                    ];
                }
                break;

            case 'DELETE':
                if (preg_match('#^/jobs/([^/]+)$#', $path, $matches)) {
                    $result = $jobQueue->cancelJob($matches[1]);
                    return [
                        'status' => '200 OK',
                        'headers' => ['Content-Type' => 'application/json'],
                        'body' => json_encode($result)
                    ];
                }
                break;
        }

        throw new NotFoundException('Endpoint not found');
    } catch (InvalidArgumentException $e) {
        return [
            'status' => '400 Bad Request',
            'headers' => ['Content-Type' => 'application/json'],
            'body' => json_encode(['success' => false, 'error' => $e->getMessage()])
        ];
    } catch (NotFoundException $e) {
        return [
            'status' => '404 Not Found',
            'headers' => ['Content-Type' => 'application/json'],
            'body' => json_encode(['success' => false, 'error' => $e->getMessage()])
        ];
    } catch (Throwable $e) {
        return [
            'status' => '500 Internal Server Error',
            'headers' => ['Content-Type' => 'application/json'],
            'body' => json_encode(['success' => false, 'error' => 'Internal server error'])
        ];
    }
}

// If accessed via web server, handle the request
if (php_sapi_name() !== 'cli') {
    $method = $_SERVER['REQUEST_METHOD'];
    $uri = $_SERVER['REQUEST_URI'];
    $headers = getallheaders() ?: [];
    $body = file_get_contents('php://input');
    $response = handleRequest($method, $uri, $headers, $body);

    header($response['status']);
    foreach ($response['headers'] as $name => $value) {
        header("$name: $value");
    }
    echo $response['body'];
    exit;
}

/**
 * Exception for invalid arguments.
 */
class InvalidArgumentException extends Exception {}

/**
 * Exception for not found resources.
 */
class NotFoundException extends Exception {}

/**
 * Database schema DDL (for migration purposes).
 * Note: This is provided as a constant string for the user to execute.
 */
const DATABASE_SCHEMA = <<<SQL
CREATE TABLE IF NOT EXISTS jobs (
    id CHAR(36) PRIMARY KEY,
    task_type VARCHAR(50) NOT NULL,
    params JSON NOT NULL,
    status ENUM('enqueued', 'running', 'completed', 'failed', 'cancelled') NOT NULL DEFAULT 'enqueued',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    progress VARCHAR(20) DEFAULT '0/0',
    result JSON NULL,
    error TEXT NULL,
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 3,
    next_retry_at TIMESTAMP NULL,
    scheduled_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
    id CHAR(36) PRIMARY KEY,
    job_id CHAR(36) NOT NULL,
    status ENUM('running', 'completed', 'failed') NOT NULL,
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    result JSON NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
SQL;
?>