const { initDB, signup, verify_email, login, oauth_callback, mfa_challenge, token_refresh, dbPromise } = require('./auth_system_javascript');
const { expect } = require('@jest/globals');

beforeAll(async () => {
  await initDB();
});

describe('Auth System Tests', () => {
  const ip = '1.2.3.4';
  const device = 'device123';

  test('signup happy path', async () => {
    const res = await signup('user@example.com', 'StrongPassword123456', 'Alice', ip);
    expect(res.success).toBe(true);
    expect(res.status).toBe('pending_verification');
  });

  test('signup duplicate email', async () => {
    await signup('dup@example.com', 'StrongPassword123456', 'Bob', ip);
    const res = await signup('dup@example.com', 'StrongPassword123456', 'Bob', ip);
    expect(res.error).toBe('email_already_exists');
  });

  test('signup weak password', async () => {
    const res = await signup('weak@example.com', 'short', 'Carol', ip);
    expect(res.error).toBe('password_too_weak');
  });

  test('signup IP rate limit', async () => {
    for (let i = 0; i < 5; i++) {
      await signup(`rate${i}@example.com`, 'StrongPassword123456', 'Dave', ip);
    }
    const res = await signup('rate6@example.com', 'StrongPassword123456', 'Dave', ip);
    expect(res.error).toBe('too_many_signups_from_ip');
  });

  test('verify_email happy path', async () => {
    const email = 'verify@example.com';
    await signup(email, 'StrongPassword123456', 'Eve', ip);
    const db = dbPromise;
    const codeRow = await db.then(db => db.get(`SELECT * FROM verification_codes WHERE type='email'`));
    const res = await verify_email(email, codeRow.code);
    expect(res.success).toBe(true);
    expect(res.status).toBe('verified');
  });

  test('verify_email expired code', async () => {
    const email = 'expire@example.com';
    await signup(email, 'StrongPassword123456', 'Frank', ip);
    const db = dbPromise;
    await db.then(db => db.run(`UPDATE verification_codes SET expires_at = ? WHERE type='email'`, new Date(Date.now() - 1000).toISOString()));
    const codeRow = await db.then(db => db.get(`SELECT * FROM verification_codes WHERE type='email'`));
    const res = await verify_email(email, codeRow.code);
    expect(res.error).toBe('code_expired');
  });

  test('login happy path (no MFA)', async () => {
    const email = 'login@example.com';
    await signup(email, 'StrongPassword123456', 'Grace', ip);
    const db = dbPromise;
    const codeRow = await db.then(db => db.get(`SELECT * FROM verification_codes WHERE type='email'`));
    await verify_email(email, codeRow.code);
    const res = await login(email, 'StrongPassword123456', device, ip);
    expect(res.success).toBe(true);
    expect(res.status).toBe('authenticated');
    expect(res.token).toBeDefined();
  });

  test('login with MFA enabled', async () => {
    const email = 'mfa@example.com';
    await signup(email, 'StrongPassword123456', 'Heidi', ip);
    const db = dbPromise;
    const codeRow = await db.then(db => db.get(`SELECT * FROM verification_codes WHERE type='email'`));
    await verify_email(email, codeRow.code);
    const secret = speakeasy.generateSecret().base32;
    await db.then(db => db.run(`UPDATE users SET mfa_secret = ?, mfa_enabled = 1 WHERE email = ?`, secret, email));
    const res = await login(email, 'StrongPassword123456', device, ip);
    expect(res.success).toBe(true);
    expect(res.status).toBe('mfa_required');
    expect(res.challenge_id).toBeDefined();
  });

  test('login invalid password', async () => {
    const email = 'badpass@example.com';
    await signup(email, 'StrongPassword123456', 'Ivan', ip);
    const db = dbPromise;
    const codeRow = await db.then(db => db.get(`SELECT * FROM verification_codes WHERE type='email'`));
    await verify_email(email, codeRow.code);
    const res = await login(email, 'WrongPassword', device, ip);
    expect(res.error).toBe('invalid_credentials');
  });

  test('oauth_callback happy path (new user)', async () => {
    const email = 'oauthnew@example.com';
    const res = await oauth_callback('google', email, 'state123', ip, device);
    expect(res.success).toBe(true);
    expect(res.status).toBe('authenticated');
    expect(res.user.email).toBe(email);
  });

  test('oauth_callback existing user', async () => {
    const email = 'oauthexist@example.com';
    await signup(email, 'StrongPassword123456', 'Judy', ip);
    const db = dbPromise;
    const codeRow = await db.then(db => db.get(`SELECT * FROM verification_codes WHERE type='email'`));
    await verify_email(email, codeRow.code);
    const res = await oauth_callback('google', email, 'state123', ip, device);
    expect(res.success).toBe(true);
    expect(res.status).toBe('authenticated');
    expect(res.user.email).toBe(email);
  });

  test('mfa_challenge happy path', async () => {
    const email = 'mfa2@example.com';
    await signup(email, 'StrongPassword123456', 'Ken', ip);
    const db = dbPromise;
    const codeRow = await db.then(db => db.get(`SELECT * FROM verification_codes WHERE type='email'`));
    await verify_email(email, codeRow.code);
    const secret = speakeasy.generateSecret().base32;
    await db.then(db => db.run(`UPDATE users SET mfa_secret = ?, mfa_enabled = 1 WHERE email = ?`, secret, email));
    const loginRes = await login(email, 'StrongPassword123456', device, ip);
    const challenge_id = loginRes.challenge_id;
    const totp = speakeasy.totp({ secret, encoding: 'base32' });
    const res = await mfa_challenge(challenge_id, totp, ip, device);
    expect(res.success).toBe(true);
    expect(res.status).toBe('authenticated');
    expect(res.token).toBeDefined();
  });

  test('mfa_challenge wrong code', async () => {
    const email = 'mfa3@example.com';
    await signup(email, 'StrongPassword123456', 'Leo', ip);
    const db = dbPromise;
    const codeRow = await db.then(db => db.get(`SELECT * FROM verification_codes WHERE type='email'`));
    await verify_email(email, codeRow.code);
    const secret = speakeasy.generateSecret().base32;
    await db.then(db => db.run(`UPDATE users SET mfa_secret = ?, mfa_enabled = 1 WHERE email = ?`, secret, email));
    const loginRes = await login(email, 'StrongPassword123456', device, ip);
    const challenge_id = loginRes.challenge_id;
    const res = await mfa_challenge(challenge_id, 'wrongcode', ip, device);
    expect(res.error).toBe('invalid_code');
  });

  test('token_refresh happy path', async () => {
    const email = 'refresh@example.com';
    await signup(email, 'StrongPassword123456', 'Mia', ip);
    const db = dbPromise;
    const codeRow = await db.then(db => db.get(`SELECT * FROM verification_codes WHERE type='email'`));
    await verify_email(email, codeRow.code);
    const loginRes = await login(email, 'StrongPassword123456', device, ip);
    const session = await db.then(db => db.get(`SELECT * FROM sessions WHERE id = ?`, loginRes.session_id));
    const res = await token_refresh(session.refresh_token);
    expect(res.success).toBe(true);
    expect(res.status).toBe('ok');
    expect(res.token).toBeDefined();
  });

  test('token_refresh banned user', async () => {
    const email = 'banned@example.com';
    await signup(email, 'StrongPassword123456', 'Nina', ip);
    const db = dbPromise;
    const codeRow = await db.then(db => db.get(`SELECT * FROM verification_codes WHERE type='email'`));
    await verify_email(email, codeRow.code);
    const loginRes = await login(email, 'StrongPassword123456', device, ip);
    await db.then(db => db.run(`UPDATE users SET status = 'banned' WHERE email = ?`, email));
    const session = await db.then(db => db.get(`SELECT * FROM sessions WHERE id = ?`, loginRes.session_id));
    const res = await token_refresh(session.refresh_token);
    expect(res.error).toBe('user_banned');
  });
});

module.exports = {};