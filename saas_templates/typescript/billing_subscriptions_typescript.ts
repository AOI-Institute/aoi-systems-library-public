import { Pool, QueryResult } from 'pg';
import Stripe from 'stripe';

// Database schema as executable DDL
export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,
  customer_id VARCHAR(255) NOT NULL,
  tier VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  cancelled_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  stripe_invoice_id VARCHAR(255) UNIQUE NOT NULL,
  customer_id VARCHAR(255) NOT NULL,
  amount INTEGER NOT NULL,
  status VARCHAR(50) NOT NULL,
  paid_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS refunds (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER REFERENCES invoices(id),
  amount INTEGER NOT NULL,
  status VARCHAR(50) NOT NULL,
  reason TEXT NOT NULL,
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  executed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  stripe_event_id VARCHAR(255) UNIQUE NOT NULL,
  event_type VARCHAR(255) NOT NULL,
  processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
`;

interface StripePriceIds {
  solo: string;
  team: string;
  enterprise: string;
}

const getPriceIds = (): StripePriceIds => {
  // In a real implementation, these would come from environment variables or config
  return {
    solo: process.env.STRIPE_PRICE_SOLO || 'price_1UI...',
    team: process.env.STRIPE_PRICE_TEAM || 'price_1UI...',
    enterprise: process.env.STRIPE_PRICE_ENTERPRISE || 'price_1UI...'
  };
};

let _stripe: Stripe | null = null;
let _dbPool: Pool | null = null;

export const initialize = (stripeSecretKey: string, connectionString: string) => {
  _stripe = new Stripe(stripeSecretKey, { apiVersion: '2020-08-27' });
  _dbPool = new Pool({ connectionString });
};

const getStripe = (): Stripe => {
  if (!_stripe) {
    throw new Error('Stripe not initialized. Call initialize() first.');
  }
  return _stripe;
};

const getDbPool = (): Pool => {
  if (!_dbPool) {
    throw new Error('Database pool not initialized. Call initialize() first.');
  }
  return _dbPool;
};

export const create_subscription = async (customer_id: string, tier: string): Promise<{success: true, subscription_id: string, tier: string, status: string, next_billing_date: string} | {error: string, message: string}> => {
  const priceIds = getPriceIds();
  if (![priceIds.solo, priceIds.team, priceIds.enterprise].includes(tier)) {
    return { error: 'invalid_tier', message: `Invalid tier: ${tier}` };
  }

  const stripe = getStripe();
  const pool = getDbPool();

  try {
    const subscription = await stripe.subscriptions.create({
      customer: customer_id,
      items: [{ price: tier }],
      expand: ['latest_invoice.payment_intent']
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `INSERT INTO subscriptions (stripe_subscription_id, customer_id, tier, status, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING id, stripe_subscription_id, customer_id, tier, status, created_at`,
        [subscription.id, customer_id, tier, subscription.status]
      );
      const dbRecord = res.rows[0];

      await client.query(
        `INSERT INTO audit_log (action, customer_id, tier, stripe_sub_id)
         VALUES ($1, $2, $3, $4)`,
        ['subscription_created', customer_id, tier, subscription.id]
      );

      await client.query('COMMIT');

      const next_billing_date = new Date(subscription.current_period_end * 1000).toISOString();
      return {
        success: true,
        subscription_id: subscription.id,
        tier: subscription.items.data[0].price.lookup_key || tier,
        status: subscription.status,
        next_billing_date
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err: any) {
    return { error: 'stripe_error', message: err.message };
  }
};

export const change_plan = async (subscription_id: string, new_tier: string): Promise<{success: true, subscription_id: string, old_tier: string, new_tier: string, effective_date: string, proration_credit: number} | {error: string, message: string}> => {
  const priceIds = getPriceIds();
  if (![priceIds.solo, priceIds.team, priceIds.enterprise].includes(new_tier)) {
    return { error: 'invalid_tier', message: `Invalid tier: ${new_tier}` };
  }

  const stripe = getStripe();
  const pool = getDbPool();

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Get current subscription
    const subRes = await client.query(
      `SELECT stripe_subscription_id, tier FROM subscriptions WHERE stripe_subscription_id = $1`,
      [subscription_id]
    );
    if (subRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: 'subscription_not_found', message: `Subscription not found: ${subscription_id}` };
    }
    const old_tier = subRes.rows[0].tier;
    const stripe_subscription_id = subRes.rows[0].stripe_subscription_id;

    // Update in Stripe
    const subscription = await stripe.subscriptions.update(stripe_subscription_id, {
      items: [{ price: new_tier }],
      proration_behavior: 'create_prorations',
      expand: ['latest_invoice']
    });

    // Update DB
    await client.query(
      `UPDATE subscriptions SET tier = $1, updated_at = NOW() WHERE stripe_subscription_id = $2`,
      [new_tier, stripe_subscription_id]
    );

    // Calculate proration credit from latest invoice
    const proration_credit = subscription.latest_invoice ? 
      (subscription.latest_invoice as Stripe.Invoice).amount_due : 0;

    await client.query(
      `INSERT INTO audit_log (action, subscription_id, old_tier, new_tier, proration_credits)
       VALUES ($1, $2, $3, $4, $5)`,
      ['plan_changed', subscription_id, old_tier, new_tier, proration_credit]
    );

    await client.query('COMMIT');

    const effective_date = new Date(subscription.current_period_start * 1000).toISOString();
    return {
      success: true,
      subscription_id: subscription.id,
      old_tier,
      new_tier,
      effective_date,
      proration_credit: Math.abs(proration_credit) / 100 // Convert from cents to dollars
    };
  } catch (err: any) {
    if (client) {
      await client.query('ROLLBACK');
    }
    return { error: 'stripe_error', message: err.message };
  } finally {
    if (client) {
      client.release();
    }
  }
};

export const queue_refund = async (invoice_id: string, amount: number, reason: string, created_by: string): Promise<{success: true, refund_id: number, status: string, amount: number, reason: string} | {error: string, message: string}> => {
  if (amount <= 0) {
    return { error: 'invalid_amount', message: 'Amount must be positive' };
  }

  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Check invoice exists and is succeeded
    const invoiceRes = await client.query(
      `SELECT id, amount, status FROM invoices WHERE stripe_invoice_id = $1`,
      [invoice_id]
    );
    if (invoiceRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: 'invoice_not_found', message: `Invoice not found: ${invoice_id}` };
    }
    const invoice = invoiceRes.rows[0];
    if (invoice.status !== 'succeeded') {
      await client.query('ROLLBACK');
      return { error: 'invoice_not_succeeded', message: `Invoice status is ${invoice.status}, expected succeeded` };
    }
    if (amount > invoice.amount) {
      await client.query('ROLLBACK');
      return { error: 'refund_exceeds_invoice', message: `Refund amount ${amount} exceeds invoice amount ${invoice.amount}` };
    }

    // Create refund record
    const refundRes = await client.query(
      `INSERT INTO refunds (invoice_id, amount, status, reason, created_by)
       VALUES ($1, $2, 'queued', $3, $4)
       RETURNING id`,
      [invoice.id, amount, reason, created_by]
    );
    const refund_id = refundRes.rows[0].id;

    await client.query(
      `INSERT INTO audit_log (action, invoice_id, amount, reason)
       VALUES ($1, $2, $3, $4)`,
      ['refund_queued', invoice_id, amount, reason]
    );

    await client.query('COMMIT');

    return {
      success: true,
      refund_id,
      status: 'queued',
      amount,
      reason
    };
  } catch (err: any) {
    if (client) {
      await client.query('ROLLBACK');
    }
    return { error: 'database_error', message: err.message };
  } finally {
    if (client) {
      client.release();
    }
  }
};

export const handle_stripe_webhook = async (event: Stripe.Event): Promise<{received: true} | {error: string, message: string}> => {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Idempotency check
    const eventRes = await client.query(
      `SELECT id FROM events WHERE stripe_event_id = $1`,
      [event.id]
    );
    if (eventRes.rowCount > 0) {
      await client.query('COMMIT');
      return { received: true };
    }

    // Process event based on type
    switch (event.type) {
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        await client.query(
          `INSERT INTO invoices (stripe_invoice_id, customer_id, amount, status, paid_at)
           VALUES ($1, $2, $3, 'succeeded', NOW())
           ON CONFLICT (stripe_invoice_id) DO UPDATE SET
             status = EXCLUDED.status,
             paid_at = EXCLUDED.paid_at`,
          [invoice.id, invoice.customer, invoice.amount_paid]
        );
        await client.query(
          `INSERT INTO audit_log (action, customer_id, invoice_id, amount)
           VALUES ($1, $2, $3, $4)`,
          ['payment_succeeded', invoice.customer, invoice.id, invoice.amount_paid]
        );
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await client.query(
          `UPDATE subscriptions SET status = 'past_due' WHERE customer_id = $1`,
          [invoice.customer]
        );
        await client.query(
          `INSERT INTO audit_log (action, customer_id, invoice_id, reason)
           VALUES ($1, $2, $3, $4)`,
          ['payment_failed', invoice.customer, invoice.id, invoice.last_error?.message || 'unknown']
        );
        break;
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const new_tier = subscription.items.data[0].price.lookup_key;
        await client.query(
          `UPDATE subscriptions SET 
           tier = $1, 
           status = $2, 
           updated_at = NOW() 
           WHERE stripe_subscription_id = $3`,
          [new_tier, subscription.status, subscription.id]
        );
        await client.query(
          `INSERT INTO audit_log (action, customer_id, old_tier, new_tier)
           VALUES ($1, $2, (SELECT tier FROM subscriptions WHERE stripe_subscription_id = $3), $4)`,
          ['subscription_updated', subscription.customer, subscription.id, new_tier]
        );
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await client.query(
          `UPDATE subscriptions SET 
           status = 'cancelled', 
           cancelled_at = NOW() 
           WHERE stripe_subscription_id = $1`,
          [subscription.id]
        );
        await client.query(
          `INSERT INTO audit_log (action, customer_id)
           VALUES ($1, $2)`,
          ['subscription_cancelled', subscription.customer]
        );
        break;
      }
      default:
        // Ignore other event types but still record as processed
        break;
    }

    // Record event as processed
    await client.query(
      `INSERT INTO events (stripe_event_id, event_type)
       VALUES ($1, $2)`,
      [event.id, event.type]
    );

    await client.query('COMMIT');
    return { received: true };
  } catch (err: any) {
    if (client) {
      await client.query('ROLLBACK');
    }
    return { error: 'webhook_processing_error', message: err.message };
  } finally {
    if (client) {
      client.release();
    }
  }
};