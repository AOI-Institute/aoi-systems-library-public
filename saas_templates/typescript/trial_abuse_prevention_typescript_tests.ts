import { db, signup, subscription_created, check_email_trial_history, check_payment_method_history, check_ip_signup_rate_limit, check_device_fingerprint, check_trial_payment_timing, check_chargeback_history, record_device_fingerprint } from './trial_abuse_prevention_typescript';
import { createHash } from 'crypto';

beforeEach(() => {
  // Reset DB
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('DROP TABLE IF EXISTS trial_abuse_ledger;');
  db.exec('DROP TABLE IF EXISTS device_fingerprints;');
  db.exec('DROP TABLE IF EXISTS gate_decisions;');
  db.exec(`
    CREATE TABLE trial_abuse_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      stripe_payment_method_id TEXT,
      ip TEXT NOT NULL,
      device_fingerprint TEXT,
      signup_date DATETIME NOT NULL,
      trial_started_at DATETIME NOT NULL,
      payment_added_date DATETIME,
      subscription_status TEXT,
      chargeback_count INTEGER DEFAULT 0,
      refund_count INTEGER DEFAULT 0,
      gate_flags TEXT NOT NULL,
      alert_reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE device_fingerprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      device_hash TEXT NOT NULL,
      user_agent TEXT,
      screen_resolution TEXT,
      timezone TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE gate_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      gate_name TEXT NOT NULL,
      decision TEXT NOT NULL,
      rule_inputs TEXT,
      rule_outputs TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
});

test('email_trial_history PASS → new email allowed', () => {
  const result = signup({
    email: 'new@example.com',
    password: 'pwd',
    ip: '1.2.3.4',
    user_agent: 'ua',
    screen_resolution: '1920x1080',
    timezone: 'UTC',
    browser_language: 'en'
  });
  expect(result.success).toBe(true);
  expect(result.error).toBeUndefined();
});

test('email_trial_history CHALLENGE → same email after 1 trial, flagged', () => {
  // Insert prior completed trial
  db.prepare(`
    INSERT INTO trial_abuse_ledger (user_id, email, ip, signup_date, trial_started_at, gate_flags, subscription_status)
    VALUES (100, 'repeat@example.com', '1.2.3.4', datetime('now'), datetime('now'), '{}', 'completed')
  `).run();

  const result = signup({
    email: 'repeat@example.com',
    password: 'pwd',
    ip: '5.6.7.8',
    user_agent: 'ua',
    screen_resolution: '1920x1080',
    timezone: 'UTC',
    browser_language: 'en'
  });
  expect(result.success).toBe(true);
  expect(result.user?.abuse_flags).toContain('email_trial_attempt_2+');
});

test('email_trial_history FAIL → same email after 2 trials, rejected', () => {
  // Two prior trials
  db.prepare(`
    INSERT INTO trial_abuse_ledger (user_id, email, ip, signup_date, trial_started_at, gate_flags, subscription_status)
    VALUES (101, 'blocked@example.com', '1.2.3.4', datetime('now'), datetime('now'), '{}', 'completed')
  `).run();
  db.prepare(`
    INSERT INTO trial_abuse_ledger (user_id, email, ip, signup_date, trial_started_at, gate_flags, subscription_status)
    VALUES (102, 'blocked@example.com', '5.6.7.8', datetime('now'), datetime('now'), '{}', 'completed')
  `).run();

  const result = signup({
    email: 'blocked@example.com',
    password: 'pwd',
    ip: '9.10.11.12',
    user_agent: 'ua',
    screen_resolution: '1920x1080',
    timezone: 'UTC',
    browser_language: 'en'
  });
  expect(result.success).toBe(false);
  expect(result.error?.error).toBe('email_has_trial_history');
  expect(result.error?.code).toBe(409);
});

test('payment_method_history PASS → new card allowed', () => {
  const decision = check_payment_method_history('pm_new', 200);
  expect(decision.decision).toBe('PASS');
});

test('payment_method_history FAIL → same card after 3 trials, rejected', () => {
  // Insert three prior trials with same payment method
  for (let i = 0; i < 3; i++) {
    db.prepare(`
      INSERT INTO trial_abuse_ledger (user_id, email, ip, stripe_payment_method_id, signup_date, trial_started_at, gate_flags, subscription_status)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), '{}', 'completed')
    `).run(300 + i, `u${i}@example.com`, `1.2.3.${i}`, 'pm_reused');
  }
  const decision = check_payment_method_history('pm_reused', 400);
  expect(decision.decision).toBe('FAIL');
});

test('ip_signup_rate_limit PASS → < 5 signups from IP, allowed', () => {
  // 3 prior signups
  for (let i = 0; i < 3; i++) {
    db.prepare(`
      INSERT INTO trial_abuse_ledger (user_id, email, ip, signup_date, trial_started_at, gate_flags)
      VALUES (?, ?, ?, datetime('now'), datetime('now'), '{}')
    `).run(500 + i, `ip${i}@example.com`, '8.8.8.8');
  }
  const decision = check_ip_signup_rate_limit('8.8.8.8', 600);
  expect(decision.decision).toBe('PASS');
});

test('ip_signup_rate_limit FAIL → 10+ signups from IP, rejected', () => {
  for (let i = 0; i < 10; i++) {
    db.prepare(`
      INSERT INTO trial_abuse_ledger (user_id, email, ip, signup_date, trial_started_at, gate_flags)
      VALUES (?, ?, ?, datetime('now'), datetime('now'), '{}')
    `).run(700 + i, `ip${i}@example.com`, '9.9.9.9');
  }
  const decision = check_ip_signup_rate_limit('9.9.9.9', 800);
  expect(decision.decision).toBe('FAIL');
});

test('device_fingerprint PASS → device < 2 users, allowed', () => {
  const device = {
    user_agent: 'ua1',
    screen_resolution: '1920x1080',
    timezone: 'UTC',
    browser_language: 'en'
  };
  const decision = check_device_fingerprint(device, 900);
  expect(decision.decision).toBe('PASS');
});

test('device_fingerprint FAIL → device > 5 users, rejected', () => {
  const device = {
    user_agent: 'ua_shared',
    screen_resolution: '1280x720',
    timezone: 'UTC',
    browser_language: 'en'
  };
  const deviceString = `${device.user_agent}|${device.screen_resolution}|${device.timezone}|${device.browser_language}`;
  const deviceHash = createHash('sha256').update(deviceString).digest('hex');

  // Insert 6 distinct users with same device hash
  for (let i = 0; i < 6; i++) {
    db.prepare(`
      INSERT INTO device_fingerprints (user_id, device_hash, user_agent, screen_resolution, timezone)
      VALUES (?, ?, ?, ?, ?)
    `).run(1000 + i, deviceHash, device.user_agent, device.screen_resolution, device.timezone);
  }

  const decision = check_device_fingerprint(device, 1100);
  expect(decision.decision).toBe('FAIL');
});

test('trial_payment_timing PASS → payment within trial window, allowed', () => {
  // Create a user with trial started 5 days ago
  const now = new Date();
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
  db.prepare(`
    INSERT INTO trial_abuse_ledger (user_id, email, ip, signup_date, trial_started_at, gate_flags)
    VALUES (1200, 'timing@example.com', '1.1.1.1', ?, ?, '{}')
  `).run(fiveDaysAgo.toISOString(), fiveDaysAgo.toISOString());

  const decision = check_trial_payment_timing(1200, 14);
  expect(decision.decision).toBe('PASS');
});

test('trial_payment_timing FAIL → trial ended, no payment, trying to re-add, rejected', () => {
  // Trial started 100 days ago, no payment
  const now = new Date();
  const hundredDaysAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
  db.prepare(`
    INSERT INTO trial_abuse_ledger (user_id, email, ip, signup_date, trial_started_at, gate_flags)
    VALUES (1300, 'ended@example.com', '2.2.2.2', ?, ?, '{}')
  `).run(hundredDaysAgo.toISOString(), hundredDaysAgo.toISOString());

  const decision = check_trial_payment_timing(1300, 14);
  expect(decision.decision).toBe('FAIL');
});

test('chargeback_history PASS → no chargebacks, allowed', () => {
  const decision = check_chargeback_history('cust_no_cb', 1400);
  expect(decision.decision).toBe('PASS');
});

test('chargeback_history FAIL → 2+ chargebacks, requires prepayment', () => {
  // Insert two chargeback events
  db.exec(`
    CREATE TABLE stripe_events (id INTEGER PRIMARY KEY AUTOINCREMENT, customer TEXT, type TEXT);
    CREATE TABLE refunds (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, status TEXT);
  `);
  db.prepare(`INSERT INTO stripe_events (customer, type) VALUES ('cust_bad', 'chargeback.initiated')`).run();
  db.prepare(`INSERT INTO stripe_events (customer, type) VALUES ('cust_bad', 'chargeback.reversed')`).run();
  db.prepare(`INSERT INTO refunds (user_id, status) VALUES (1500, 'chargebacked')`).run();

  const decision = check_chargeback_history('cust_bad', 1500);
  expect(decision.decision).toBe('FAIL');
});

test('integration: full signup and subscription flow with challenges', () => {
  // First signup (PASS)
  const signupRes = signup({
    email: 'full@example.com',
    password: 'pwd',
    ip: '3.3.3.3',
    user_agent: 'ua',
    screen_resolution: '1920x1080',
    timezone: 'UTC',
    browser_language: 'en'
  });
  expect(signupRes.success).toBe(true);
  const user = signupRes.user!;
  // Record device fingerprint
  record_device_fingerprint({
    user_id: user.id,
    device: {
      user_agent: 'ua',
      screen_resolution: '1920x1080',
      timezone: 'UTC',
      browser_language: 'en'
    }
  });

  // Subscription creation with new payment method (PASS)
  const subRes = subscription_created({
    user_id: user.id,
    stripe_payment_method_id: 'pm_new2',
    stripe_customer_id: 'cust_new2'
  });
  expect(subRes.success).toBe(true);
  expect(subRes.challenge).toBeUndefined();
});

test('integration: payment method reuse challenge', () => {
  // Setup prior usage of payment method twice
  for (let i = 0; i < 2; i++) {
    db.prepare(`
      INSERT INTO trial_abuse_ledger (user_id, email, ip, stripe_payment_method_id, signup_date, trial_started_at, gate_flags, subscription_status)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), '{}', 'completed')
    `).run(2000 + i, `reuse${i}@example.com`, '4.4.4.4', 'pm_challenge');
  }

  // New user signup
  const signupRes = signup({
    email: 'reuse@example.com',
    password: 'pwd',
    ip: '5.5.5.5',
    user_agent: 'ua',
    screen_resolution: '1920x1080',
    timezone: 'UTC',
    browser_language: 'en'
  });
  expect(signupRes.success).toBe(true);
  const user = signupRes.user!;

  // Subscription with reused payment method (CHALLENGE)
  const subRes = subscription_created({
    user_id: user.id,
    stripe_payment_method_id: 'pm_challenge',
    stripe_customer_id: 'cust_challenge'
  });
  expect(subRes.success).toBe(true);
  expect(subRes.challenge?.type).toBe('email_confirm');
  expect(subRes.challenge?.flags).toContain('payment_reuse_2x');
});