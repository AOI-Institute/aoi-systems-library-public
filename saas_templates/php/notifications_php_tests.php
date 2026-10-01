<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use NotificationSystem\NotificationService;
use NotificationSystem\seedTemplates;
use NotificationSystem\runMigrations;

final class NotificationServiceTest extends TestCase
{
    private PDO $pdo;
    private NotificationService $service;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->service = new NotificationService($this->pdo, [], []);
        seedTemplates($this->pdo);
    }

    public function testSendEmailWithTemplateVariables(): void
    {
        $payload = [
            'user_id' => 1,
            'template_key' => 'trial_ending_soon',
            'channel' => 'email',
            'vars' => ['days_left' => 3],
            'scheduled_at' => null
        ];
        $result = $this->service->endpointSend($payload);
        $this->assertTrue($result['success']);
        $this->assertEquals('sent', $result['status']);
        $this->assertNotNull($result['message_id']);
    }

    public function testSendSms(): void
    {
        $payload = [
            'user_id' => 2,
            'template_key' => 'welcome_email',
            'channel' => 'sms',
            'vars' => ['app_name' => 'TestApp'],
            'scheduled_at' => null
        ];
        $result = $this->service->endpointSend($payload);
        $this->assertTrue($result['success']);
        $this->assertEquals('sent', $result['status']);
    }

    public function testSendInAppStoresInDb(): void
    {
        $payload = [
            'user_id' => 3,
            'template_key' => 'admin_alert',
            'channel' => 'in_app',
            'vars' => ['actor' => 'Alice', 'action' => 'delete', 'resource' => 'file.txt'],
            'scheduled_at' => null
        ];
        $result = $this->service->endpointSend($payload);
        $this->assertTrue($result['success']);
        $this->assertEquals('sent', $result['status']);

        $stmt = $this->pdo->prepare('SELECT * FROM notification_logs WHERE id = :id');
        $stmt->execute([':id' => $result['message_id']]);
        $log = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertEquals('sent', $log['status']);
    }

    public function testBatchSendLargeNumber(): void
    {
        $batch = [];
        for ($i = 1; $i <= 50; $i++) {
            $batch[] = [
                'user_id' => $i,
                'template_key' => 'welcome_email',
                'channel' => 'email',
                'vars' => ['app_name' => 'App' . $i],
                'scheduled_at' => null
            ];
        }
        $result = $this->service->endpointSendBatch($batch);
        $this->assertTrue($result['success']);
        $this->assertEquals(50, $result['sent']);
        $this->assertEquals(0, $result['failed']);
        $this->assertCount(50, $result['message_ids']);
    }

    public function testQuietHoursSkipAndQueue(): void
    {
        // Set quiet hours covering current UTC time
        $prefStmt = $this->pdo->prepare('INSERT INTO user_notification_preferences (user_id, do_not_disturb, quiet_hours_start, quiet_hours_end, channels_enabled) VALUES (100, 0, :start, :end, :ch)');
        $prefStmt->execute([
            ':start' => (new DateTimeImmutable('now', new DateTimeZone('UTC')))->modify('-1 hour')->format('H:i'),
            ':end'   => (new DateTimeImmutable('now', new DateTimeZone('UTC')))->modify('+1 hour')->format('H:i'),
            ':ch'    => json_encode(['email'=>true,'sms'=>true,'in_app'=>true])
        ]);

        $payload = [
            'user_id' => 100,
            'template_key' => 'welcome_email',
            'channel' => 'email',
            'vars' => ['app_name' => 'QuietApp'],
            'scheduled_at' => null
        ];
        $result = $this->service->endpointSend($payload);
        $this->assertEquals('queued', $result['status']);
        $this->assertNotNull($result['message_id']);

        // Verify scheduled_at stored
        $stmt = $this->pdo->prepare('SELECT sent_at FROM notification_logs WHERE id = :id');
        $stmt->execute([':id' => $result['message_id']]);
        $sentAt = $stmt->fetchColumn();
        $this->assertNotNull($sentAt);
    }

    public function testDoNotDisturbSkips(): void
    {
        $prefStmt = $this->pdo->prepare('INSERT INTO user_notification_preferences (user_id, do_not_disturb, channels_enabled) VALUES (200, 1, :ch)');
        $prefStmt->execute([':ch' => json_encode(['email'=>true,'sms'=>true,'in_app'=>true])]);

        $payload = [
            'user_id' => 200,
            'template_key' => 'welcome_email',
            'channel' => 'email',
            'vars' => ['app_name' => 'DNDApp'],
            'scheduled_at' => null
        ];
        $result = $this->service->endpointSend($payload);
        $this->assertEquals('skipped', $result['status']);
        $this->assertNull($result['message_id']);
    }

    public function testTrackMessageStatusUpdates(): void
    {
        $payload = [
            'user_id' => 5,
            'template_key' => 'welcome_email',
            'channel' => 'email',
            'vars' => ['app_name' => 'TrackApp'],
            'scheduled_at' => null
        ];
        $sendRes = $this->service->endpointSend($payload);
        $msgId = $sendRes['message_id'];
        $track = $this->service->endpointTrack((string)$msgId);
        $this->assertEquals('sent', $track['status']);
        $this->assertNotNull($track['sent_at']);
    }

    public function testRetryOnFailure(): void
    {
        // Override sendEmail to force failure first two attempts
        $service = $this->getMockBuilder(NotificationService::class)
            ->setConstructorArgs([$this->pdo, [], []])
            ->onlyMethods(['sendEmail'])
            ->getMock();

        $service->expects($this->exactly(3))
            ->method('sendEmail')
            ->will($this->onConsecutiveCalls(
                $this->throwException(new Exception('SMTP error')),
                $this->throwException(new Exception('SMTP error')),
                $this->returnValue(null)
            ));

        // Seed templates again for the mock
        seedTemplates($this->pdo);

        $payload = [
            'user_id' => 6,
            'template_key' => 'welcome_email',
            'channel' => 'email',
            'vars' => ['app_name' => 'RetryApp'],
            'scheduled_at' => null
        ];
        $result = $service->endpointSend($payload);
        $this->assertTrue($result['success']);
        $this->assertEquals('sent', $result['status']);
    }

    public function testUnsubscribeLinkIncludedInEmail(): void
    {
        // Capture output of mail() using a custom stream wrapper
        $mailLog = '';
        $originalMail = function_exists('mail') ? 'mail' : null;
        // Override mail function within this test scope
        runkit_function_redefine('mail', '$to,$subject,$message,$headers', '
            global $mailLog;
            $mailLog = $message;
            return true;
        ');
        $payload = [
            'user_id' => 7,
            'template_key' => 'welcome_email',
            'channel' => 'email',
            'vars' => ['app_name' => 'UnsubApp'],
            'scheduled_at' => null
        ];
        $result = $this->service->endpointSend($payload);
        $this->assertTrue($result['success']);
        $this->assertStringContainsString('unsubscribe', $mailLog);
        // Restore original mail if needed (skip for brevity)
    }

    public function testUserPreferencesHonored(): void
    {
        // Disable SMS for user
        $prefStmt = $this->pdo->prepare('INSERT INTO user_notification_preferences (user_id, do_not_disturb, channels_enabled) VALUES (300, 0, :ch)');
        $prefStmt->execute([':ch' => json_encode(['email'=>true,'sms'=>false,'in_app'=>true])]);

        $payload = [
            'user_id' => 300,
            'template_key' => 'welcome_email',
            'channel' => 'sms',
            'vars' => ['app_name' => 'PrefApp'],
            'scheduled_at' => null
        ];
        $result = $this->service->endpointSend($payload);
        $this->assertEquals('skipped', $result['status']);
        $this->assertNull($result['message_id']);
    }
}
?>