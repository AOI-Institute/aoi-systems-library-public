<?php
declare(strict_types=1);

namespace Compliance;

use PDO;
use PDOException;
use Exception;
use DateTimeImmutable;
use DateInterval;

/**
 * Simple in‑memory SQLite database wrapper.
 */
class Database
{
    private static ?PDO $pdo = null;

    public static function init(): void
    {
        if (self::$pdo !== null) {
            return;
        }
        self::$pdo = new PDO('sqlite::memory:');
        self::$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        self::migrate();
    }

    private static function migrate(): void
    {
        $sql = <<<SQL
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    tier TEXT NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    ip TEXT NOT NULL,
    device TEXT NOT NULL,
    started_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    details TEXT,
    performed_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE export_requests (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    requested_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
    format TEXT NOT NULL CHECK(format IN ('json','csv')),
    file_url TEXT,
    completed_at TEXT,
    expires_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE deletion_requests (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    requested_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','completed','cancelled')),
    reason TEXT NOT NULL,
    confirmation_token TEXT,
    scheduled_at TEXT,
    deleted_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);
SQL;
        self::$pdo->exec($sql);
    }

    public static function get(): PDO
    {
        self::init();
        return self::$pdo;
    }
}

/**
 * Simple audit logger.
 */
class AuditLog
{
    public static function record(?int $userId, string $action, ?string $details = null): void
    {
        $stmt = Database::get()->prepare(
            'INSERT INTO audit_log (user_id, action, details, created_at) VALUES (:user_id, :action, :details, :created_at)'
        );
        $stmt->execute([
            ':user_id' => $userId,
            ':action' => $action,
            ':details' => $details,
            ':created_at' => (new DateTimeImmutable())->format(DateTimeImmutable::ATOM),
        ]);
    }
}

/**
 * Mock S3 client – stores files in a local array.
 */
class S3Client
{
    /** @var array<string,string> */
    private static array $storage = [];

    public static function upload(string $key, string $content): string
    {
        self::$storage[$key] = $content;
        // In a real implementation this would be an S3 URL.
        return 'https://s3.mock/' . $key;
    }

    public static function getSignedUrl(string $key, int $ttlSeconds = 604800): string
    {
        // Simple signed URL simulation.
        $expires = (new DateTimeImmutable())->add(new DateInterval('PT' . $ttlSeconds . 'S'))->format(DateTimeImmutable::ATOM);
        return 'https://s3.mock/' . $key . '?expires=' . urlencode($expires) . '&signature=mocked';
    }
}

/**
 * Mock email service.
 */
class EmailService
{
    /** @var array<int,array<string,mixed>> */
    public static array $sent = [];

    public static function send(int $userId, string $subject, string $body): void
    {
        self::$sent[] = [
            'user_id' => $userId,
            'subject' => $subject,
            'body' => $body,
        ];
    }

    public static function reset(): void
    {
        self::$sent = [];
    }
}

/**
 * Simple job queue – runs jobs immediately for this demo.
 */
class JobQueue
{
    public static function dispatch(callable $job): void
    {
        // In production this would be async. Here we run synchronously.
        $job();
    }
}

/**
 * Core compliance service.
 */
class ComplianceService
{
    // ---------- EXPORT ----------
    public static function requestExport(int $userId, string $format): array
    {
        if (!in_array($format, ['json', 'csv'], true)) {
            throw new Exception('Invalid format');
        }

        $exportId = self::generateUuid();
        $now = (new DateTimeImmutable())->format(DateTimeImmutable::ATOM);
        $stmt = Database::get()->prepare(
            'INSERT INTO export_requests (id, user_id, requested_at, status, format) VALUES (:id, :user_id, :requested_at, :status, :format)'
        );
        $stmt->execute([
            ':id' => $exportId,
            ':user_id' => $userId,
            ':requested_at' => $now,
            ':status' => 'pending',
            ':format' => $format,
        ]);

        AuditLog::record($userId, 'data_export_requested', json_encode(['format' => $format, 'export_id' => $exportId]));

        // Dispatch background job
        JobQueue::dispatch(function () use ($exportId, $userId, $format) {
            self::processExport($exportId, $userId, $format);
        });

        $willEmailAt = (new DateTimeImmutable('+1 minute'))->format(DateTimeImmutable::ATOM);
        return [
            'success' => true,
            'export_id' => $exportId,
            'status' => 'pending',
            'will_email_at' => $willEmailAt,
        ];
    }

    private static function processExport(string $exportId, int $userId, string $format): void
    {
        try {
            $data = self::gatherUserData($userId);
            $content = $format === 'json' ? json_encode($data, JSON_PRETTY_PRINT) : self::convertToCsv($data);
            $key = "exports/{$exportId}.{$format}";
            $url = S3Client::upload($key, $content);
            $signedUrl = S3Client::getSignedUrl($key, 604800); // 7 days

            $now = (new DateTimeImmutable())->format(DateTimeImmutable::ATOM);
            $expires = (new DateTimeImmutable('+7 days'))->format(DateTimeImmutable::ATOM);

            $stmt = Database::get()->prepare(
                'UPDATE export_requests SET status = :status, file_url = :file_url, completed_at = :completed_at, expires_at = :expires_at WHERE id = :id'
            );
            $stmt->execute([
                ':status' => 'completed',
                ':file_url' => $signedUrl,
                ':completed_at' => $now,
                ':expires_at' => $expires,
                ':id' => $exportId,
            ]);

            // Send email
            $subject = 'Your data export is ready';
            $body = "Dear user,\n\nYour data export is ready. Download it here (expires in 7 days):\n{$signedUrl}\n\nRegards,\nCompliance Team";
            EmailService::send($userId, $subject, $body);
        } catch (Exception $e) {
            $stmt = Database::get()->prepare('UPDATE export_requests SET status = :status WHERE id = :id');
            $stmt->execute([':status' => 'failed', ':id' => $exportId]);
            AuditLog::record($userId, 'data_export_failed', $e->getMessage());
        }
    }

    public static function getExportStatus(string $exportId): array
    {
        $stmt = Database::get()->prepare('SELECT * FROM export_requests WHERE id = :id');
        $stmt->execute([':id' => $exportId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            throw new Exception('Export not found');
        }
        return [
            'export_id' => $row['id'],
            'status' => $row['status'],
            'file_url' => $row['file_url'],
            'expires_at' => $row['expires_at'],
            'requested_at' => $row['requested_at'],
        ];
    }

    // ---------- DELETION ----------
    public static function requestDeletion(int $userId, string $reason): array
    {
        $allowed = ['user_requested','gdpr_request','gdpr_right_to_be_forgotten','other'];
        if (!in_array($reason, $allowed, true)) {
            throw new Exception('Invalid reason');
        }

        $deletionId = self::generateUuid();
        $token = bin2hex(random_bytes(16));
        $now = (new DateTimeImmutable())->format(DateTimeImmutable::ATOM);
        $stmt = Database::get()->prepare(
            'INSERT INTO deletion_requests (id, user_id, requested_at, status, reason, confirmation_token) VALUES (:id, :user_id, :requested_at, :status, :reason, :token)'
        );
        $stmt->execute([
            ':id' => $deletionId,
            ':user_id' => $userId,
            ':requested_at' => $now,
            ':status' => 'pending',
            ':reason' => $reason,
            ':token' => $token,
        ]);

        AuditLog::record($userId, 'deletion_requested', json_encode(['reason' => $reason, 'deletion_id' => $deletionId]));

        // Send confirmation email
        $confirmUrl = "https://example.com/compliance/delete/{$deletionId}/confirm?token={$token}";
        $subject = 'Confirm your account deletion';
        $body = "Dear user,\n\nPlease confirm your account deletion by clicking the link below. This will start a 30‑day grace period.\n{$confirmUrl}\n\nIf you did not request this, ignore this email.\n\nRegards,\nCompliance Team";
        EmailService::send($userId, $subject, $body);

        $willDeleteAt = (new DateTimeImmutable('+30 days'))->format(DateTimeImmutable::ATOM);
        return [
            'success' => true,
            'deletion_id' => $deletionId,
            'status' => 'pending',
            'will_delete_at' => $willDeleteAt,
        ];
    }

    public static function confirmDeletion(string $deletionId, string $token): array
    {
        $stmt = Database::get()->prepare('SELECT * FROM deletion_requests WHERE id = :id');
        $stmt->execute([':id' => $deletionId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            throw new Exception('Deletion request not found');
        }
        if ($row['status'] !== 'pending') {
            throw new Exception('Deletion not pending');
        }
        if (!hash_equals($row['confirmation_token'], $token)) {
            throw new Exception('Invalid confirmation token');
        }

        $scheduledAt = (new DateTimeImmutable('+30 days'))->format(DateTimeImmutable::ATOM);
        $stmt = Database::get()->prepare('UPDATE deletion_requests SET status = :status, scheduled_at = :scheduled_at WHERE id = :id');
        $stmt->execute([
            ':status' => 'approved',
            ':scheduled_at' => $scheduledAt,
            ':id' => $deletionId,
        ]);

        AuditLog::record((int)$row['user_id'], 'deletion_confirmed', json_encode(['deletion_id' => $deletionId]));

        // Dispatch job that will run after the grace period – for test we run immediately.
        JobQueue::dispatch(function () use ($deletionId) {
            self::executeDeletion($deletionId);
        });

        return [
            'success' => true,
            'deletion_scheduled_for' => $scheduledAt,
        ];
    }

    private static function executeDeletion(string $deletionId): void
    {
        $stmt = Database::get()->prepare('SELECT * FROM deletion_requests WHERE id = :id');
        $stmt->execute([':id' => $deletionId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return;
        }
        if ($row['status'] !== 'approved') {
            return;
        }

        $userId = (int)$row['user_id'];

        // Cascade delete (except audit_log)
        $tables = ['sessions','activities','files','preferences','transactions','export_requests','deletion_requests'];
        foreach ($tables as $table) {
            $stmtDel = Database::get()->prepare("DELETE FROM {$table} WHERE user_id = :uid");
            $stmtDel->execute([':uid' => $userId]);
        }

        // Finally delete user record
        $stmtDelUser = Database::get()->prepare('DELETE FROM users WHERE id = :uid');
        $stmtDelUser->execute([':uid' => $userId]);

        $deletedAt = (new DateTimeImmutable())->format(DateTimeImmutable::ATOM);
        $stmt = Database::get()->prepare('UPDATE deletion_requests SET status = :status, deleted_at = :deleted_at WHERE id = :id');
        $stmt->execute([
            ':status' => 'completed',
            ':deleted_at' => $deletedAt,
            ':id' => $deletionId,
        ]);

        AuditLog::record($userId, 'deletion_completed', json_encode(['deletion_id' => $deletionId]));
    }

    public static function cancelDeletion(string $deletionId): array
    {
        $stmt = Database::get()->prepare('SELECT * FROM deletion_requests WHERE id = :id');
        $stmt->execute([':id' => $deletionId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            throw new Exception('Deletion request not found');
        }
        if (!in_array($row['status'], ['pending','approved'], true)) {
            throw new Exception('Cannot cancel at this stage');
        }

        $stmt = Database::get()->prepare('UPDATE deletion_requests SET status = :status WHERE id = :id');
        $stmt->execute([
            ':status' => 'cancelled',
            ':id' => $deletionId,
        ]);

        AuditLog::record((int)$row['user_id'], 'deletion_cancelled', json_encode(['deletion_id' => $deletionId]));

        return [
            'success' => true,
            'status' => 'cancelled',
        ];
    }

    // ---------- ADMIN ----------
    public static function listExports(?int $adminUserId, array $filters = []): array
    {
        // In a real system we would verify admin rights. Omitted for brevity.
        $sql = 'SELECT * FROM export_requests WHERE 1=1';
        $params = [];

        if (isset($filters['user_id'])) {
            $sql .= ' AND user_id = :user_id';
            $params[':user_id'] = $filters['user_id'];
        }
        if (isset($filters['status'])) {
            $sql .= ' AND status = :status';
            $params[':status'] = $filters['status'];
        }

        $stmt = Database::get()->prepare($sql);
        $stmt->execute($params);
        $exports = $stmt->fetchAll(PDO::FETCH_ASSOC);
        return [
            'exports' => $exports,
            'total' => count($exports),
        ];
    }

    public static function listDeletions(?int $adminUserId, array $filters = []): array
    {
        $sql = 'SELECT * FROM deletion_requests WHERE 1=1';
        $params = [];

        if (isset($filters['user_id'])) {
            $sql .= ' AND user_id = :user_id';
            $params[':user_id'] = $filters['user_id'];
        }
        if (isset($filters['status'])) {
            $sql .= ' AND status = :status';
            $params[':status'] = $filters['status'];
        }

        $stmt = Database::get()->prepare($sql);
        $stmt->execute($params);
        $deletions = $stmt->fetchAll(PDO::FETCH_ASSOC);
        return [
            'deletions' => $deletions,
            'total' => count($deletions),
        ];
    }

    // ---------- HELPERS ----------
    private static function generateUuid(): string
    {
        // Simple UUID v4 generator.
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    private static function gatherUserData(int $userId): array
    {
        $db = Database::get();

        $profile = $db->prepare('SELECT id,email,name,created_at,tier,status FROM users WHERE id = :uid');
        $profile->execute([':uid' => $userId]);
        $profileData = $profile->fetch(PDO::FETCH_ASSOC) ?: [];

        $sessions = $db->prepare('SELECT ip,device,started_at FROM sessions WHERE user_id = :uid');
        $sessions->execute([':uid' => $userId]);
        $sessionsData = $sessions->fetchAll(PDO::FETCH_ASSOC);

        $activities = $db->prepare('SELECT type,details,performed_at FROM activities WHERE user_id = :uid');
        $activities->execute([':uid' => $userId]);
        $activitiesData = $activities->fetchAll(PDO::FETCH_ASSOC);

        $files = $db->prepare('SELECT filename,size,uploaded_at FROM files WHERE user_id = :uid');
        $files->execute([':uid' => $userId]);
        $filesData = $files->fetchAll(PDO::FETCH_ASSOC);

        $preferences = $db->prepare('SELECT key,value FROM preferences WHERE user_id = :uid');
        $preferences->execute([':uid' => $userId]);
        $preferencesData = $preferences->fetchAll(PDO::FETCH_ASSOC);

        $transactions = $db->prepare('SELECT amount,currency,type,created_at FROM transactions WHERE user_id = :uid');
        $transactions->execute([':uid' => $userId]);
        $transactionsData = $transactions->fetchAll(PDO::FETCH_ASSOC);

        $audit = $db->prepare('SELECT action,details,created_at FROM audit_log WHERE user_id = :uid');
        $audit->execute([':uid' => $userId]);
        $auditData = $audit->fetchAll(PDO::FETCH_ASSOC);

        return [
            'profile' => $profileData,
            'sessions' => $sessionsData,
            'activities' => $activitiesData,
            'files' => $filesData,
            'preferences' => $preferencesData,
            'transactions' => $transactionsData,
            'audit_trail' => $auditData,
        ];
    }

    private static function convertToCsv(array $data): string
    {
        // Flatten each top‑level key into its own CSV section.
        $lines = [];
        foreach ($data as $section => $records) {
            $lines[] = $section;
            if (empty($records)) {
                $lines[] = '';
                continue;
            }
            $header = array_keys(is_array($records[0]) ? $records[0] : []);
            $lines[] = implode(',', $header);
            foreach ($records as $row) {
                $escaped = array_map(function ($v) {
                    $v = (string)$v;
                    if (strpos($v, ',') !== false || strpos($v, '"') !== false) {
                        $v = '"' . str_replace('"', '""', $v) . '"';
                    }
                    return $v;
                }, $row);
                $lines[] = implode(',', $escaped);
            }
            $lines[] = ''; // blank line between sections
        }
        return implode("\n", $lines);
    }
}

/**
 * Simple router for demonstration – maps HTTP method + path to service calls.
 * In tests we call the service methods directly.
 */