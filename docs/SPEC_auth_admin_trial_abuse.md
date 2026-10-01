# Reference spec — Login/Auth, Admin and Trial-Abuse Prevention

**Scope:** 3 interconnected systems, 8 languages parallel  
**Outcome:** Identical API contract across Python | JavaScript | Java | C# | PHP | Go | Rust | TypeScript

---

## PART 1: LOGIN + AUTH (with replay ledger)

### 6 Auth Flows (each replay-enabled)
1. Email/password signup (with verification code)
2. Email verification (code/link)
3. Login (email + password, MFA optional)
4. OAuth callback (Google/GitHub/Reddit)
5. MFA challenge (TOTP/SMS code)
6. Token refresh (keep session alive)

### Every flow logs:
- `why_chain`: decision points (email_unique, password_correct, mfa_gate, rate_limit, etc)
- `audit_log`: action record (user_created, email_verified, session_created, etc)
- `replay_ledger`: snapshot + can_replay flag (for debugging)

### Replay executor:
- Given `why_chain_id`, re-execute flow with frozen user snapshot
- Detect divergence (user deleted, tier changed, now banned, etc)

**See:** LOGIN_AUTH_REPLAY_SPEC.md (6 flows, exact sequence, schema)

---

## PART 2: ADMIN SYSTEM (5 domains)

### Endpoints (owner-only gates, audit log every mutation)

**Users domain:**
- POST /admin/users/action → create | reset_password | change_role | suspend

**Customers domain:**
- GET /admin/customers (list, search, paginate)
- GET /admin/customers/{id} (detail)
- POST /admin/customers/{id}/action → change_plan | queue_refund

**Deployments domain:**
- GET /admin/deployments
- POST /admin/deployments/action → create | assign_domain | publish | suspend | retire

**Governance domain:**
- GET /admin/governance/actions (pending)
- POST /admin/governance/actions/{id}/decide → approve | reject
- GET /admin/governance/audit-log (search all mutations)

**Services domain:** SKIP (awaits owner decision)

### Auth pattern (same across all 8 langs):
```
@admin_endpoint
def handler(action, current_account, db_session):
    require_owner_scope(current_account)  # 403 if not
    validate_input(action, params)
    
    # Execute mutation
    result = db.execute(action, params)
    
    # Write audit
    audit_log.write({
        actor_id: current_account.id,
        action: action,
        resource_type: "user" | "customer" | "deployment" | "approval",
        resource_id: ...,
        old_value: before_dict,
        new_value: after_dict
    })
    
    return {success: True, ...result}
```

---

## PART 3: TRIAL ABUSE PREVENTION (gates + guards)

### The problem:
Users sign up for free trial, cancel card, re-signup, cancel, repeat endlessly → free forever.

### Solution: Multi-gate fraud detection

#### Gate 1: Email-based deduplication
```
On signup(email):
  Rule: email not in trial_abuse_ledger
    Decision: PASS if (email never had trial before)
    Decision: FAIL if (email already claimed trial AND now_has_active_subscription)
    Decision: CHALLENGE if (email had trial expired 60+ days ago, allow re-signup with flag)
    
    log: why_chain(decision_point="email_trial_history", email, past_trials, challenge_flag)
    
If FAIL: return 409 {error: "trial_already_used_by_email", message: "contact support"}
If CHALLENGE: flag user as "trial_attempt_2+" in user.flags field, proceed (but watch)
```

#### Gate 2: Payment method deduplication
```
On first successful payment(user_id, stripe_payment_method_id):
  Rule: payment_method not in trial_abuse_ledger
    Query: SELECT * FROM trial_abuse_ledger WHERE stripe_payment_method_id = ?
    
    Decision: PASS if (no prior trial with this card)
    Decision: FAIL if (3+ prior trials with this card in 90 days)
    Decision: ALERT if (2+ prior trials with this card)
    
    log: why_chain(decision_point="payment_method_trial_history", 
                   payment_id, prior_count, decision)
    
If FAIL: block subscription, alert ops
If ALERT: flag user.flags += "payment_method_reuse_2x"
```

#### Gate 3: IP-based rate limiting
```
On signup(email, ip):
  Rule: IP signup rate
    Query: SELECT COUNT(*) FROM signups 
           WHERE ip = ? AND created_at > NOW() - INTERVAL 24 HOURS
    
    Decision: PASS if count < 5
    Decision: CHALLENGE if count >= 5 AND count < 10
    Decision: FAIL if count >= 10
    
    log: why_chain(decision_point="ip_signup_rate_limit", ip, count, limit)
    
If FAIL: 429 Too Many Requests, ask user to wait/contact support
If CHALLENGE: require CAPTCHAsolver or email confirmation before trial
```

#### Gate 4: Device fingerprint tracking
```
On login(user_id, device_fingerprint):
  device = {user_agent, screen_resolution, timezone, browser_plugins, canvas_hash}
  
  Rule: device matches user's known devices
    Decision: PASS if device in user.known_devices OR new device AND email verified
    Decision: CHALLENGE if device new AND email unverified (suspicious)
    Decision: FAIL if device matches 5+ other user accounts (likely spoofed)
    
    log: why_chain(decision_point="device_fingerprint_gate", 
                   device_hash, user_device_count, matching_user_count)
    
If CHALLENGE: send email "new device login detected, confirm"
If FAIL: block login, alert ops
```

#### Gate 5: Trial start ↔ payment method timing
```
On subscription_created(user_id, tier):
  trial_start_date = user.created_at
  now = datetime.utcnow()
  
  Rule: payment method added within trial window
    If tier = "Solo" (free 14-day trial):
      Decision: PASS if (now - trial_start_date < 20 days AND payment_method_added_date > trial_start_date)
      Decision: ALERT if (now - trial_start_date > 30 days AND payment_method_added_date > trial_start_date + 25 days)
      Decision: FAIL if (trial ended AND user never added payment method, now re-adding after 90+ days)
      
      log: why_chain(decision_point="trial_payment_timing",
                     trial_duration_days, payment_delay_days, decision)
    
If ALERT: flag user.flags += "late_payment_entry", watch for chargeback patterns
If FAIL: require admin approval, escalate
```

#### Gate 6: Chargeback + refund history
```
On subscription_created(user_id):
  Rule: user refund/chargeback history
    Query: SELECT * FROM refunds WHERE user_id = ? AND status IN ("chargebacked", "disputed")
    Query: SELECT * FROM stripe_events WHERE customer = stripe_customer_id AND type LIKE "%chargeback%"
    
    Decision: PASS if no prior chargebacks/disputes
    Decision: CHALLENGE if 1 prior chargeback (could be legitimate)
    Decision: FAIL if 2+ chargebacks (pattern of abuse)
    
    log: why_chain(decision_point="chargeback_history", count, decision)
    
If FAIL: require prepayment (annual upfront), no trial
```

### Trial abuse ledger schema:

```sql
CREATE TABLE trial_abuse_ledger (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36),
  email VARCHAR(255),
  stripe_payment_method_id VARCHAR(100),  -- card fingerprint
  ip_address VARCHAR(45),
  device_fingerprint VARCHAR(100),
  signup_date TIMESTAMP,
  trial_started_at TIMESTAMP,
  trial_ended_at TIMESTAMP,
  payment_added_date TIMESTAMP,
  subscription_status VARCHAR(50),  -- "completed" | "charged_back" | "refunded" | "cancelled"
  chargeback_count INT DEFAULT 0,
  refund_count INT DEFAULT 0,
  gate_flags JSON,  -- {email_attempt_n: 2, payment_reuse_n: 1, device_reuse_n: 0, ...}
  alert_reason VARCHAR(255),
  created_at TIMESTAMP,
  INDEXES: (email), (stripe_payment_method_id), (ip_address), (device_fingerprint)
);

CREATE TABLE gate_decisions (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36),
  decision_point VARCHAR(100),  -- "email_trial_history" | "payment_method_history" | "device_fingerprint" | ...
  decision VARCHAR(20),         -- "PASS" | "CHALLENGE" | "FAIL"
  rule_inputs JSON,
  rule_outputs JSON,
  created_at TIMESTAMP
);
```

### Integration with auth flow:

```
On signup(email, password):
  
  # Gate checks (before user creation)
  email_gate = check_email_trial_history(email)
  ip_gate = check_ip_rate_limit(ip)
  
  if email_gate.decision == "FAIL":
    log(why_chain: email_gate)
    return 409 {error: "email_has_trial_history"}
  
  if ip_gate.decision == "FAIL":
    log(why_chain: ip_gate)
    return 429 {error: "ip_rate_limit_exceeded", retry_after: 86400}
  
  # Create user (with flags if CHALLENGE)
  user = User(email=email, password=hash(password))
  user.abuse_flags = []
  if email_gate.decision == "CHALLENGE":
    user.abuse_flags.append("email_trial_attempt_2+")
  if ip_gate.decision == "CHALLENGE":
    user.abuse_flags.append("ip_rate_limit_4_of_5")
  
  db.add(user)
  
  # Log to abuse ledger (for future checks)
  abuse_ledger_entry = TrialAbuseLedger(
    user_id=user.id,
    email=email,
    ip_address=ip,
    signup_date=now(),
    trial_started_at=now(),
    gate_flags={"email_gate": email_gate.decision, "ip_gate": ip_gate.decision}
  )
  db.add(abuse_ledger_entry)
  
  db.commit()
  
  # Send verification email (normal flow)
  send_verification_email(email, user.id)
  
  return {status: "pending_verification", email, flags: user.abuse_flags}

---

On payment(user_id, stripe_payment_method_id):
  
  payment_gate = check_payment_method_history(stripe_payment_method_id)
  timing_gate = check_trial_payment_timing(user_id)
  chargeback_gate = check_chargeback_history(user_id)
  
  if any gate is FAIL:
    log(why_chain for each)
    return 403 {error: "subscription_cannot_process", reason: gate.reason}
  
  # Create subscription
  subscription = create_subscription(user_id, stripe_payment_method_id)
  
  # Update abuse ledger
  abuse_entry = db.query(TrialAbuseLedger).filter(TrialAbuseLedger.user_id == user_id).first()
  abuse_entry.payment_added_date = now()
  abuse_entry.stripe_payment_method_id = stripe_payment_method_id
  abuse_entry.gate_flags.update({
    "payment_gate": payment_gate.decision,
    "timing_gate": timing_gate.decision,
    "chargeback_gate": chargeback_gate.decision
  })
  db.commit()
  
  return {status: "subscribed", subscription_id, ...}
```

---

---

## Deliverables per language

Each language directory holds, per system, an implementation file and a tests file
(`<system>_<lang>.<ext>` and `<system>_<lang>_tests.<ext>`). Every language must produce
identical API responses for identical input. Responses are JSON: `{success: true, ...}` or
`{error: "code", message: "..."}`. Every mutation writes an audit-log entry.
