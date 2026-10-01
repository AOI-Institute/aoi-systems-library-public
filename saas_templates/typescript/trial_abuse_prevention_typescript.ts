import Database from 'better-sqlite3';
import { createHash } from 'crypto';

// ---------- Types ----------
type Decision = 'PASS' | 'CHALLENGE' | 'FAIL';

interface GateResult {
  decision: Decision;
  priorCount?: number;
  count?: number;
  matchingUsers?: number;
  deviceHash?: string;
  trialDuration?: number;
  paymentDelay?: number;
}

interface User {
  id: number;
  email: string;
  created_at: Date;
  abuse_flags: string[];
}

interface AbuseLedgerEntry {
  id?: number;
  user_id: number;
  email: string;
  stripe_payment_method_id?: string;
  ip: string;
  device_fingerprint?: string;
  signup_date: Date;
  trial_started_at: Date;
  payment_added_date?: Date;
  subscription_status?: string;
  chargeback_count?: number;
  refund_count?: number;
  gate_flags: Record<string, Decision>;
  alert_reason?: string;
  created_at: Date;
}

// ---------- DB Setup ----------
export const db = new Database(':memory:');

// Migration (DDL)
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
  gate_flags TEXT NOT NULL, -- JSON
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
  rule_inputs TEXT,  -- JSON
  rule_outputs TEXT, -- JSON
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

// ---------- Helper Functions ----------
function why_chain(params: {
  user_id: number;
  gate_name: string;
  decision: Decision;
  rule_inputs: any;
  rule_outputs: any;
}) {
  const stmt = db.prepare(`
    INSERT INTO gate_decisions (user_id, gate_name, decision, rule_inputs, rule_outputs)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.user_id,
    params.gate_name,
    params.decision,
    JSON.stringify(params.rule_inputs),
    JSON.stringify(params.rule_outputs)
  );
}

// ---------- Gate Implementations ----------
export function check_email_trial_history(email: string, userId: number): GateResult {
  const rows = db.prepare(`
    SELECT subscription_status FROM trial_abuse_ledger
    WHERE email = ? AND subscription_status IN ('completed', 'chargebacked')
  `).all(email);

  const priorCount = rows.length;
  let decision: Decision = 'PASS';
  if (priorCount === 0) decision = 'PASS';
  else if (priorCount === 1) decision = 'CHALLENGE';
  else decision = 'FAIL';

  why_chain({
    user_id: userId,
    gate_name: 'email_trial_history',
    decision,
    rule_inputs: { email, priorCount },
    rule_outputs: { decision }
  });

  return { decision, priorCount };
}

export function check_payment_method_history(stripePaymentMethodId: string, userId: number): GateResult {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM trial_abuse_ledger
    WHERE stripe_payment_method_id = ? AND subscription_status IN ('completed', 'chargebacked')
  `).get(stripePaymentMethodId);
  const priorCount = row.cnt as number;

  let decision: Decision = 'PASS';
  if (priorCount < 2) decision = 'PASS';
  else if (priorCount === 2) decision = 'CHALLENGE';
  else decision = 'FAIL';

  why_chain({
    user_id: userId,
    gate_name: 'payment_method_history',
    decision,
    rule_inputs: { stripePaymentMethodId, priorCount },
    rule_outputs: { decision }
  });

  return { decision, priorCount };
}

export function check_ip_signup_rate_limit(ip: string, userId: number): GateResult {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM trial_abuse_ledger
    WHERE ip = ? AND signup_date > datetime('now', '-24 hours')
  `).get(ip);
  const count = row.cnt as number;

  let decision: Decision = 'PASS';
  if (count < 5) decision = 'PASS';
  else if (count >= 5 && count < 10) decision = 'CHALLENGE';
  else decision = 'FAIL';

  why_chain({
    user_id: userId,
    gate_name: 'ip_signup_rate_limit',
    decision,
    rule_inputs: { ip, count },
    rule_outputs: { decision }
  });

  return { decision, count };
}

export function check_device_fingerprint(device: {
  user_agent: string;
  screen_resolution: string;
  timezone: string;
  browser_language: string;
}, userId: number): GateResult {
  const deviceString = `${device.user_agent}|${device.screen_resolution}|${device.timezone}|${device.browser_language}`;
  const deviceHash = createHash('sha256').update(deviceString).digest('hex');

  const row = db.prepare(`
    SELECT COUNT(DISTINCT user_id) as cnt FROM device_fingerprints
    WHERE device_hash = ?
  `).get(deviceHash);
  const matchingUsers = row.cnt as number;

  let decision: Decision = 'PASS';
  if (matchingUsers < 2) decision = 'PASS';
  else if (matchingUsers >= 2 && matchingUsers <= 5) decision = 'CHALLENGE';
  else decision = 'FAIL';

  why_chain({
    user_id: userId,
    gate_name: 'device_fingerprint',
    decision,
    rule_inputs: { deviceHash, matchingUsers },
    rule_outputs: { decision }
  });

  return { decision, matchingUsers, deviceHash };
}

export function check_trial_payment_timing(userId: number, trialDays: number = 14): GateResult {
  const userRow = db.prepare(`SELECT created_at FROM trial_abuse_ledger WHERE user_id = ? ORDER BY id ASC LIMIT 1`).get(userId);
  if (!userRow) {
    // No trial info; treat as PASS
    why_chain({
      user_id: userId,
      gate_name: 'trial_payment_timing',
      decision: 'PASS',
      rule_inputs: {},
      rule_outputs: {}
    });
    return { decision: 'PASS' };
  }

  const trialStart = new Date(userRow.created_at);
  const now = new Date();
  const daysElapsed = Math.floor((now.getTime() - trialStart.getTime()) / (1000 * 60 * 60 * 24));

  const paymentRow = db.prepare(`
    SELECT payment_added_date FROM trial_abuse_ledger
    WHERE user_id = ? AND payment_added_date IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(userId);
  const paymentAddedDate = paymentRow ? new Date(paymentRow.payment_added_date) : null;

  let decision: Decision = 'PASS';
  if (paymentAddedDate) {
    // payment already added; PASS
    decision = 'PASS';
  } else {
    if (daysElapsed < trialDays + 5) {
      decision = 'PASS';
    } else if (daysElapsed > trialDays + 30) {
      decision = 'CHALLENGE';
    } else {
      // trial ended without payment and trying to re-add after 90+ days (simplified)
      if (daysElapsed >= 90) decision = 'FAIL';
      else decision = 'PASS';
    }
  }

  why_chain({
    user_id: userId,
    gate_name: 'trial_payment_timing',
    decision,
    rule_inputs: { trialStart, now, daysElapsed, paymentAddedDate },
    rule_outputs: { decision }
  });

  return { decision, trialDuration: daysElapsed };
}

export function check_chargeback_history(stripeCustomerId: string, userId: number): GateResult {
  const chargebackRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM stripe_events
    WHERE customer = ? AND type LIKE '%chargeback%'
  `).get(stripeCustomerId);
  const chargebackCount = chargebackRow.cnt as number;

  const refundRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM refunds
    WHERE user_id = ? AND status = 'chargebacked'
  `).get(userId);
  const refundCount = refundRow.cnt as number;

  const totalChargebacks = chargebackCount + refundCount;

  let decision: Decision = 'PASS';
  if (totalChargebacks === 0) decision = 'PASS';
  else if (totalChargebacks === 1) decision = 'CHALLENGE';
  else decision = 'FAIL';

  why_chain({
    user_id: userId,
    gate_name: 'chargeback_history',
    decision,
    rule_inputs: { stripeCustomerId, totalChargebacks },
    rule_outputs: { decision }
  });

  return { decision, chargebacks: totalChargebacks };
}

// ---------- Core Flows ----------
let userIdSeq = 1;
export function signup(params: {
  email: string;
  password: string; // not stored in this demo
  ip: string;
  user_agent: string;
  screen_resolution: string;
  timezone: string;
  browser_language: string;
}): { success: boolean; error?: any; challenge?: any; user?: User } {
  const {
    email,
    ip,
    user_agent,
    screen_resolution,
    timezone,
    browser_language
  } = params;

  const tempUserId = userIdSeq++; // provisional ID for logging

  const emailGate = check_email_trial_history(email, tempUserId);
  const ipGate = check_ip_signup_rate_limit(ip, tempUserId);

  if (emailGate.decision === 'FAIL') {
    return {
      success: false,
      error: { error: 'email_has_trial_history', message: 'Email has prior trial history', code: 409 }
    };
  }
  if (ipGate.decision === 'FAIL') {
    return {
      success: false,
      error: { error: 'too_many_signups_from_ip', message: 'Rate limit exceeded', code: 429, retry_after: 86400 }
    };
  }

  // Create user
  const user: User = {
    id: tempUserId,
    email,
    created_at: new Date(),
    abuse_flags: []
  };

  // Apply challenge flags
  if (emailGate.decision === 'CHALLENGE') {
    user.abuse_flags.push('email_trial_attempt_2+');
  }
  if (ipGate.decision === 'CHALLENGE') {
    // In real flow, would require CAPTCHA; here we just note it
    return {
      success: true,
      challenge: { type: 'captcha' },
      user
    };
  }

  // Insert ledger entry
  const ledgerStmt = db.prepare(`
    INSERT INTO trial_abuse_ledger
    (user_id, email, ip, signup_date, trial_started_at, gate_flags)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  ledgerStmt.run(
    user.id,
    email,
    ip,
    new Date().toISOString(),
    new Date().toISOString(),
    JSON.stringify({ email: emailGate.decision, ip: ipGate.decision })
  );

  return { success: true, user };
}

export function subscription_created(params: {
  user_id: number;
  stripe_payment_method_id: string;
  stripe_customer_id: string;
}): { success: boolean; error?: any; challenge?: any } {
  const { user_id, stripe_payment_method_id, stripe_customer_id } = params;

  const paymentGate = check_payment_method_history(stripe_payment_method_id, user_id);
  const timingGate = check_trial_payment_timing(user_id);
  const chargebackGate = check_chargeback_history(stripe_customer_id, user_id);

  const failGate = [paymentGate, timingGate, chargebackGate].find(g => g.decision === 'FAIL');
  if (failGate) {
    let errorObj;
    switch (failGate) {
      case paymentGate:
        errorObj = { error: 'payment_method_used_for_multiple_trials', message: 'Payment method reused', code: 403 };
        break;
      case timingGate:
        errorObj = { error: 'trial_ended_no_payment_cannot_retry', message: 'Trial ended without payment', code: 403 };
        break;
      case chargebackGate:
        errorObj = { error: 'chargeback_history_requires_prepayment', message: 'Chargeback history requires prepayment', code: 403 };
        break;
      default:
        errorObj = { error: 'unknown', message: 'Unknown failure', code: 403 };
    }
    return { success: false, error: errorObj };
  }

  // Update ledger with payment info
  const updateStmt = db.prepare(`
    UPDATE trial_abuse_ledger
    SET payment_added_date = ?, stripe_payment_method_id = ?, subscription_status = 'completed',
        gate_flags = json_set(gate_flags, '$.payment', ?, '$.timing', ?, '$.chargeback', ?)
    WHERE user_id = ?
  `);
  updateStmt.run(
    new Date().toISOString(),
    stripe_payment_method_id,
    paymentGate.decision,
    timingGate.decision,
    chargebackGate.decision,
    user_id
  );

  // Handle challenges
  const challenges: string[] = [];
  if (paymentGate.decision === 'CHALLENGE') challenges.push('payment_reuse_2x');
  if (timingGate.decision === 'CHALLENGE') challenges.push('late_payment_entry');
  if (chargebackGate.decision === 'CHALLENGE') challenges.push('chargeback_1x');

  if (challenges.length > 0) {
    return {
      success: true,
      challenge: { type: 'email_confirm', flags: challenges }
    };
  }

  return { success: true };
}

// ---------- Device Fingerprint Recording ----------
export function record_device_fingerprint(params: {
  user_id: number;
  device: {
    user_agent: string;
    screen_resolution: string;
    timezone: string;
    browser_language: string;
  };
}) {
  const { user_id, device } = params;
  const deviceString = `${device.user_agent}|${device.screen_resolution}|${device.timezone}|${device.browser_language}`;
  const deviceHash = createHash('sha256').update(deviceString).digest('hex');

  const stmt = db.prepare(`
    INSERT INTO device_fingerprints
    (user_id, device_hash, user_agent, screen_resolution, timezone)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    user_id,
    deviceHash,
    device.user_agent,
    device.screen_resolution,
    device.timezone
  );
}

// ---------- Exported for Tests ----------
export const tables = {
  trial_abuse_ledger: 'trial_abuse_ledger',
  device_fingerprints: 'device_fingerprints',
  gate_decisions: 'gate_decisions'
};