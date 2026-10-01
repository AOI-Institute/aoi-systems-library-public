<?php
declare(strict_types=1);

use Compliance\Database;
use Compliance\ComplianceService;
use Compliance\EmailService;
use Compliance\AuditLog;

function assertEqual($a, $b, string $msg = ''): void
{
    if ($a !== $b) {
        $message = $msg ?: "Assertion failed: " . var_export($a, true) . " !== " . var_export($b, true);
        throw new Exception($message);
    }
}

function assertTrue(bool $cond, string $msg = ''): void
{
    if (!$cond) {
        $message = $msg ?: "Assertion failed: condition is false";
        throw new Exception($message);
    }
}

// Reset DB and services
Database::init();
EmailService::reset();

// Helper to create a user with related data
function seedUser(): int
{
    $db = Database::get();
    $stmt = $db->prepare('INSERT INTO users (email, name, created_at, tier, status) VALUES (:email, :name, :created_at, :tier, :status)');
    $stmt->execute([
        ':email' => 'user@example.com',
        ':name' => 'John Doe',
        ':created_at' => (new DateTimeImmutable())->format(DateTimeImmutable::ATOM),
        ':tier' => 'premium',
        ':status' => 'active',
    ]);
    $userId = (int)$db->lastInsertId();

    // Sessions
    $stmt = $db->prepare('INSERT INTO sessions (user_id, ip, device, started_at) VALUES (:uid, :ip, :device, :started_at)');
    $stmt->execute([':uid' => $userId, ':ip' => '127.0.0.1', ':device' => 'Chrome', ':started_at' => (new DateTimeImmutable('-10 days'))->format(DateTimeImmutable::ATOM)]);

    // Activity
    $stmt = $db->prepare('INSERT INTO activities (user_id, type, details, performed_at) VALUES (:uid, :type, :details, :performed_at)');
    $stmt->execute([':uid' => $userId, ':type' => 'login', ':details' => null, ':performed_at' => (new DateTimeImmutable('-9 days'))->format(DateTimeImmutable::ATOM)]);

    // Files
    $stmt = $db->prepare('INSERT INTO files (user_id, filename, size, uploaded_at) VALUES (:uid, :filename, :size, :uploaded_at)');
    $stmt->execute([':uid' => $userId, ':filename' => 'report.pdf', ':size' => 123456, ':uploaded_at' => (new DateTimeImmutable('-8 days'))->format(DateTimeImmutable::ATOM)]);

    // Preferences
    $stmt = $db->prepare('INSERT INTO preferences (user_id, key, value) VALUES (:uid, :key, :value)');
    $stmt->execute([':uid' => $userId, ':key' => 'theme', ':value' => 'dark']);

    // Transactions
    $stmt = $db->prepare('INSERT INTO transactions (user_id, amount, currency, type, created_at) VALUES (:uid, :amount, :currency, :type, :created_at)');
    $stmt->execute([':uid' => $userId, ':amount' => 49.99, ':currency' => 'USD', ':type' => 'invoice', ':created_at' => (new DateTimeImmutable('-7 days'))->format(DateTimeImmutable::ATOM)]);

    return $userId;
}

// ---------- TEST 1: Export JSON ----------
$userId = seedUser();
$response = ComplianceService::requestExport($userId, 'json');
assertTrue($response['success']);
assertTrue($response['status'] === 'pending');
$exportId = $response['export_id'];

// Since JobQueue runs synchronously, export should be completed now.
$status = ComplianceService::getExportStatus($exportId);
assertTrue($status['status'] === 'completed');
assertTrue(!empty($status['file_url']));
assertTrue(!empty($status['expires_at']));

// Email sent?
assertTrue(count(EmailService::$sent) === 1);
$email = EmailService::$sent[0];
assertTrue($email['user_id'] === $userId);
assertTrue(strpos($email['subject'], 'data export') !== false);
assertTrue(strpos($email['body'], $status['file_url']) !== false);

// ---------- TEST 2: Export CSV ----------
EmailService::reset();
$responseCsv = ComplianceService::requestExport($userId, 'csv');
$exportIdCsv = $responseCsv['export_id'];
$statusCsv = ComplianceService::getExportStatus($exportIdCsv);
assertTrue($statusCsv['status'] === 'completed');
assertTrue(strpos($statusCsv['file_url'], '.csv') !== false);
assertTrue(count(EmailService::$sent) === 1);

// ---------- TEST 3: Deletion request ----------
EmailService::reset();
$delResp = ComplianceService::requestDeletion($userId, 'gdpr_right_to_be_forgotten');
assertTrue($delResp['success']);
$deletionId = $delResp['deletion_id'];
assertTrue(strpos($delResp['will_delete_at'], 'T') !== false);
assertTrue(count(EmailService::$sent) === 1);
$confirmEmail = EmailService::$sent[0];
assertTrue(strpos($confirmEmail['subject'], 'Confirm your account deletion') !== false);
preg_match('/token=([a-f0-9]{32})/', $confirmEmail['body'], $matches);
assertTrue(!empty($matches[1]));
$token = $matches[1];

// ---------- TEST 4: Confirm deletion ----------
$confirmResp = ComplianceService::confirmDeletion($deletionId, $token);
assertTrue($confirmResp['success']);
assertTrue(strpos($confirmResp['deletion_scheduled_for'], 'T') !== false);

// Verify cascade delete (sessions, files, etc removed, audit_log kept)
$db = Database::get();
$cnt = $db->query('SELECT COUNT(*) FROM sessions WHERE user_id = ' . $userId)->fetchColumn();
assertTrue((int)$cnt === 0);
$cnt = $db->query('SELECT COUNT(*) FROM files WHERE user_id = ' . $userId)->fetchColumn();
assertTrue((int)$cnt === 0);
$cnt = $db->query('SELECT COUNT(*) FROM users WHERE id = ' . $userId)->fetchColumn();
assertTrue((int)$cnt === 0);

// Audit log should still have entries for the user
$cnt = $db->query('SELECT COUNT(*) FROM audit_log WHERE user_id = ' . $userId)->fetchColumn();
assertTrue((int)$cnt > 0);

// ---------- TEST 5: Cancel deletion (within grace period) ----------
EmailService::reset();
$userId2 = seedUser();
$delResp2 = ComplianceService::requestDeletion($userId2, 'user_requested');
$delId2 = $delResp2['deletion_id'];
preg_match('/token=([a-f0-9]{32})/', EmailService::$sent[0]['body'], $m2);
$token2 = $m2[1];
ComplianceService::confirmDeletion($delId2, $token2);
$cancelResp = ComplianceService::cancelDeletion($delId2);
assertTrue($cancelResp['success']);
assertTrue($cancelResp['status'] === 'cancelled');

// Verify user still exists
$cnt = $db->query('SELECT COUNT(*) FROM users WHERE id = ' . $userId2)->fetchColumn();
assertTrue((int)$cnt === 1);

// ---------- TEST 6: Admin list exports ----------
$adminList = ComplianceService::listExports(null, ['status' => 'completed']);
assertTrue($adminList['total'] >= 2);
foreach ($adminList['exports'] as $exp) {
    assertTrue(in_array($exp['status'], ['completed','failed','pending'], true));
}

// ---------- TEST 7: Admin list deletions ----------
$adminDelList = ComplianceService::listDeletions(null, ['status' => 'completed']);
assertTrue($adminDelList['total'] >= 1);
foreach ($adminDelList['deletions'] as $del) {
    assertTrue(in_array($del['status'], ['completed','cancelled','approved','pending'], true));
}

// ---------- TEST 8: Audit log entries ----------
$auditRows = $db->query('SELECT * FROM audit_log')->fetchAll(PDO::FETCH_ASSOC);
$actions = array_column($auditRows, 'action');
assertTrue(in_array('data_export_requested', $actions));
assertTrue(in_array('deletion_requested', $actions));
assertTrue(in_array('deletion_confirmed', $actions));
assertTrue(in_array('deletion_completed', $actions) || in_array('deletion_cancelled', $actions));

echo "All tests passed.\n";
?>