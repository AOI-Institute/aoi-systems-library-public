<?php
declare(strict_types=1);

require_once __DIR__ . '/vendor/autoload.php';

use Stripe\StripeClient;
use Stripe\Webhook;
use Stripe\Exception\SignatureVerificationException;

class BillingSystem
{
    private static ?StripeClient $stripe = null;
    private static ?PDO $pdo = null;

    // Price IDs mapping
    private const PRICE_IDS = [
        'solo'      => 'price_1UIxxxxxx',
        'team'      => 'price_1UIyyyyyy',
        'enterprise'=> 'price_1UIzzzzzz',
    ];

    // Database schema (DDL)
    public const SCHEMA = <<<SQL
CREATE TABLE IF NOT EXISTS subscriptions (
    stripe_subscription_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    cancelled_at TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
    stripe_invoice_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL,
    paid_at TEXT
);

CREATE TABLE IF NOT EXISTS refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    executed_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
    stripe_event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    data TEXT,
    created_at TEXT NOT NULL
);
SQL;

    public static function init(): void
    {
        $stripeSecret = getenv('STRIPE_SECRET_KEY');
        if (!$stripeSecret) {
            throw new RuntimeException('STRIPE_SECRET_KEY not set');
        }
        self::$stripe = new StripeClient($stripeSecret);

        $dsn = getenv('DB_DSN');
        $user = getenv('DB_USER');
        $pass = getenv('DB_PASS');
        if (!$dsn) {
            throw new RuntimeException('DB_DSN not set');
        }
        self::$pdo = new PDO($dsn, $user, $pass, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);

        // Run schema
        foreach (explode(';', trim(self::SCHEMA)) as $sql) {
            $sql = trim($sql);
            if ($sql) {
                self::$pdo->exec($sql);
            }
        }
    }

    private static function getPriceId(string $tier): string
    {
        if (!isset(self::PRICE_IDS[$tier])) {
            throw new InvalidArgumentException('invalid_tier');
        }
        return self::PRICE_IDS[$tier];
    }

    private static function auditLog(string $action, array $data): void
    {
        $stmt = self::$pdo->prepare('INSERT INTO audit_logs (action, data, created_at) VALUES (:action, :data, :created_at)');
        $stmt->execute([
            ':action' => $action,
            ':data' => json_encode($data),
            ':created_at' => (new DateTime('now', new DateTimeZone('UTC')))->format(DateTime::ATOM),
        ]);
    }

    public static function createSubscription(string $customerId, string $tier): array
    {
        try {
            $priceId = self::getPriceId($tier);
            $subscription = self::$stripe->subscriptions->create([
                'customer' => $customerId,
                'items' => [['price' => $priceId]],
            ]);

            $now = (new DateTime('now', new DateTimeZone('UTC')))->format(DateTime::ATOM);
            $stmt = self::$pdo->prepare('INSERT INTO subscriptions (stripe_subscription_id, customer_id, tier, status, created_at, updated_at) VALUES (:stripe_subscription_id, :customer_id, :tier, :status, :created_at, :updated_at)');
            $stmt->execute([
                ':stripe_subscription_id' => $subscription->id,
                ':customer_id' => $customerId,
                ':tier' => $tier,
                ':status' => 'active',
                ':created_at' => $now,
                ':updated_at' => $now,
            ]);

            self::auditLog('subscription_created', [
                'customer_id' => $customerId,
                'tier' => $tier,
                'stripe_sub_id' => $subscription->id,
            ]);

            return [
                'success' => true,
                'subscription_id' => $subscription->id,
                'tier' => $tier,
                'status' => 'active',
                'next_billing_date' => (new DateTime('@' . $subscription->current_period_end, new DateTimeZone('UTC')))->format(DateTime::ATOM),
            ];
        } catch (InvalidArgumentException $e) {
            return ['error' => 'invalid_tier', 'message' => $e->getMessage()];
        } catch (Exception $e) {
            return ['error' => 'stripe_error', 'message' => $e->getMessage()];
        }
    }

    public static function changePlan(string $subscriptionId, string $newTier): array
    {
        try {
            $priceId = self::getPriceId($newTier);
            $subscription = self::$stripe->subscriptions->update($subscriptionId, [
                'items' => [['price' => $priceId]],
            ]);

            $stmt = self::$pdo->prepare('UPDATE subscriptions SET tier = :tier, updated_at = :updated_at WHERE stripe_subscription_id = :stripe_subscription_id');
            $stmt->execute([
                ':tier' => $newTier,
                ':updated_at' => (new DateTime('now', new DateTimeZone('UTC')))->format(DateTime::ATOM),
                ':stripe_subscription_id' => $subscriptionId,
            ]);

            // Proration credit calculation placeholder
            $prorationCredit = 0;
            if (isset($subscription->proration_details)) {
                foreach ($subscription->proration_details as $detail) {
                    $prorationCredit += $detail->amount;
                }
            }

            self::auditLog('plan_changed', [
                'subscription_id' => $subscriptionId,
                'old_tier' => $subscription->plan->nickname ?? '',
                'new_tier' => $newTier,
                'proration_credits' => $prorationCredit,
            ]);

            return [
                'success' => true,
                'subscription_id' => $subscriptionId,
                'old_tier' => $subscription->plan->nickname ?? '',
                'new_tier' => $newTier,
                'effective_date' => (new DateTime('@' . $subscription->current_period_end, new DateTimeZone('UTC')))->format(DateTime::ATOM),
                'proration_credit' => $prorationCredit,
            ];
        } catch (InvalidArgumentException $e) {
            return ['error' => 'invalid_tier', 'message' => $e->getMessage()];
        } catch (Exception $e) {
            return ['error' => 'stripe_error', 'message' => $e->getMessage()];
        }
    }

    public static function queueRefund(string $invoiceId, int $amount, string $reason, string $createdBy): array
    {
        try {
            $stmt = self::$pdo->prepare('SELECT * FROM invoices WHERE stripe_invoice_id = :stripe_invoice_id');
            $stmt->execute([':stripe_invoice_id' => $invoiceId]);
            $invoice = $stmt->fetch();
            if (!$invoice) {
                return ['error' => 'invoice_not_found', 'message' => 'Invoice does not exist'];
            }
            if ($invoice['status'] !== 'succeeded') {
                return ['error' => 'invoice_not_succeeded', 'message' => 'Invoice not succeeded'];
            }
            if ($amount > $invoice['amount']) {
                return ['error' => 'refund_exceeds_invoice', 'message' => 'Refund amount exceeds invoice'];
            }

            $now = (new DateTime('now', new DateTimeZone('UTC')))->format(DateTime::ATOM);
            $stmt = self::$pdo->prepare('INSERT INTO refunds (invoice_id, amount, status, reason, created_by, created_at) VALUES (:invoice_id, :amount, :status, :reason, :created_by, :created_at)');
            $stmt->execute([
                ':invoice_id' => $invoiceId,
                ':amount' => $amount,
                ':status' => 'queued',
                ':reason' => $reason,
                ':created_by' => $createdBy,
                ':created_at' => $now,
            ]);
            $refundId = (int)self::$pdo->lastInsertId();

            self::auditLog('refund_queued', [
                'invoice_id' => $invoiceId,
                'amount' => $amount,
                'reason' => $reason,
            ]);

            return [
                'success' => true,
                'refund_id' => $refundId,
                'status' => 'queued',
                'amount' => $amount,
                'reason' => $reason,
            ];
        } catch (Exception $e) {
            return ['error' => 'db_error', 'message' => $e->getMessage()];
        }
    }

    public static function handleStripeWebhook(string $rawBody, array $headers): array
    {
        $secret = getenv('STRIPE_WEBHOOK_SECRET');
        if (!$secret) {
            return ['error' => 'missing_webhook_secret', 'message' => 'Webhook secret not configured'];
        }

        $sigHeader = $headers['Stripe-Signature'] ?? $headers['stripe-signature'] ?? null;
        if (!$sigHeader) {
            return ['error' => 'missing_signature', 'message' => 'Missing Stripe signature header'];
        }

        try {
            $event = Webhook::constructEvent($rawBody, $sigHeader, $secret);
        } catch (SignatureVerificationException $e) {
            return ['error' => 'invalid_signature', 'message' => $e->getMessage()];
        } catch (Exception $e) {
            return ['error' => 'invalid_event', 'message' => $e->getMessage()];
        }

        $eventId = $event->id;
        $eventType = $event->type;

        // Idempotency check
        $stmt = self::$pdo->prepare('SELECT 1 FROM events WHERE stripe_event_id = :stripe_event_id');
        $stmt->execute([':stripe_event_id' => $eventId]);
        if ($stmt->fetch()) {
            return ['received' => true];
        }

        // Record event
        $stmt = self::$pdo->prepare('INSERT INTO events (stripe_event_id, event_type, processed_at) VALUES (:stripe_event_id, :event_type, :processed_at)');
        $stmt->execute([
            ':stripe_event_id' => $eventId,
            ':event_type' => $eventType,
            ':processed_at' => (new DateTime('now', new DateTimeZone('UTC')))->format(DateTime::ATOM),
        ]);

        // Process event
        switch ($eventType) {
            case 'invoice.payment_succeeded':
                $invoice = $event->data->object;
                $stmt = self::$pdo->prepare('INSERT INTO invoices (stripe_invoice_id, customer_id, amount, status, paid_at) VALUES (:stripe_invoice_id, :customer_id, :amount, :status, :paid_at)');
                $stmt->execute([
                    ':stripe_invoice_id' => $invoice->id,
                    ':customer_id' => $invoice->customer,
                    ':amount' => $invoice->amount,
                    ':status' => 'succeeded',
                    ':paid_at' => (new DateTime('@' . $invoice->created, new DateTimeZone('UTC')))->format(DateTime::ATOM),
                ]);
                self::auditLog('payment_succeeded', [
                    'customer_id' => $invoice->customer,
                    'invoice_id' => $invoice->id,
                    'amount' => $invoice->amount,
                ]);
                break;

            case 'invoice.payment_failed':
                $invoice = $event->data->object;
                // Find subscription linked to invoice
                $stmt = self::$pdo->prepare('SELECT stripe_subscription_id FROM subscriptions WHERE customer_id = :customer_id');
                $stmt->execute([':customer_id' => $invoice->customer]);
                $sub = $stmt->fetch();
                if ($sub) {
                    $stmt = self::$pdo->prepare('UPDATE subscriptions SET status = :status, updated_at = :updated_at WHERE stripe_subscription_id = :stripe_subscription_id');
                    $stmt->execute([
                        ':status' => 'past_due',
                        ':updated_at' => (new DateTime('now', new DateTimeZone('UTC')))->format(DateTime::ATOM),
                        ':stripe_subscription_id' => $sub['stripe_subscription_id'],
                    ]);
                }
                self::auditLog('payment_failed', [
                    'customer_id' => $invoice->customer,
                    'invoice_id' => $invoice->id,
                    'reason' => $invoice->failure_reason ?? 'unknown',
                ]);
                break;

            case 'customer.subscription.updated':
                $subscription = $event->data->object;
                $priceId = $subscription->items->data[0]->price->id;
                $tier = array_search($priceId, self::PRICE_IDS, true);
                if ($tier === false) {
                    $tier = 'unknown';
                }
                $stmt = self::$pdo->prepare('UPDATE subscriptions SET tier = :tier, status = :status, updated_at = :updated_at WHERE stripe_subscription_id = :stripe_subscription_id');
                $stmt->execute([
                    ':tier' => $tier,
                    ':status' => $subscription->status,
                    ':updated_at' => (new DateTime('now', new DateTimeZone('UTC')))->format(DateTime::ATOM),
                    ':stripe_subscription_id' => $subscription->id,
                ]);
                self::auditLog('subscription_updated', [
                    'customer_id' => $subscription->customer,
                    'old_tier' => $subscription->previous_attributes->plan->nickname ?? '',
                    'new_tier' => $tier,
                ]);
                break;

            case 'customer.subscription.deleted':
                $subscription = $event->data->object;
                $stmt = self::$pdo->prepare('UPDATE subscriptions SET status = :status, cancelled_at = :cancelled_at, updated_at = :updated_at WHERE stripe_subscription_id = :stripe_subscription_id');
                $stmt->execute([
                    ':status' => 'cancelled',
                    ':cancelled_at' => (new DateTime('now', new DateTimeZone('UTC')))->format(DateTime::ATOM),
                    ':updated_at' => (new DateTime('now', new DateTimeZone('UTC')))->format(DateTime::ATOM),
                    ':stripe_subscription_id' => $subscription->id,
                ]);
                self::auditLog('subscription_cancelled', [
                    'customer_id' => $subscription->customer,
                ]);
                break;
        }

        return ['received' => true];
    }
}

// Initialize on load
BillingSystem::init();