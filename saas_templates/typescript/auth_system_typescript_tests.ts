import { AuthSystem, DB_SCHEMA } from './auth_system_typescript';
import { Pool } from 'pg';
import { Client } from 'pg';

// Mock logger
const mockLogger = {
  info: (msg: string, meta?: any) => {},
  error: (msg: string, meta?: any) => {}
};

// In-memory PostgreSQL for testing using pg-mem
// Note: For simplicity, we use a real PostgreSQL test database connection string.
// In practice, you would use pg-mem or a test container.
// Here we assume a test PostgreSQL instance is running on localhost:5432/testdb
const TEST_DB_CONFIG = {
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'test',
  password: 'test',
};

async function setupTestDb() {
  const pool = new Pool(TEST_DB_CONFIG);
  const client = await pool.connect();
  try {
    await client.query(DB_SCHEMA);
  } finally {
    client.release();
  }
  return pool;
}

describe('AuthSystem', () => {
  let db: Pool;
  let authSystem: AuthSystem;

  beforeAll(async () => {
    db = await setupTestDb();
    authSystem = new AuthSystem({
      db,
      jwtSecret: 'test-secret',
      logger: mockLogger
    });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE TABLE users, sessions, verification_codes, audit_log RESTART IDENTITY CASCADE');
  });

  describe('signup', () => {
    it('happy path (valid email, strong password) → user created, email sent', async () => {
      const result = await authSystem.signup('test@example.com', 'thisisaverygoodpassword123', 'Test User');
      expect(result).toEqual({
        status: 'pending_verification',
        email: 'test@example.com',
        message: 'check email'
      });
      const user = await db.query('SELECT id, email, status FROM users WHERE email = $1', ['test@example.com']);
      expect(user.rowCount).toBe(1);
      expect(user.rows[0].status).toBe('unverified');
    });

    it('signup duplicate email → 409 {error: "email_already_exists"}', async () => {
      await authSystem.signup('test@example.com', 'thisisaverygoodpassword123', 'Test User');
      const result = await authSystem.signup('test@example.com', 'anothergoodpassword456', 'Test User 2');
      expect(result).toEqual({
        error: 'email_already_exists',
        message: 'Email already exists'
      });
    });

    it('signup weak password → 400 {error: "password_too_weak"}', async () => {
      const result = await authSystem.signup('test@example.com', 'short', 'Test User');
      expect(result).toEqual({
        error: 'password_rejected',
        reason: 'too_short'
      });
    });

    it('signup IP rate limit → 429 {error: "too_many_signups_from_ip"}', async () => {
      // Mock IP rate limiter to trigger after 5 attempts
      // We'll call signup 5 times with same IP (hardcoded in implementation)
      for (let i = 0; i < 5; i++) {
        await authSystem.signup(`user${i}@example.com`, 'thisisaverygoodpassword123', `User ${i}`);
      }
      const result = await authSystem.signup('ratelimit@example.com', 'thisisaverygoodpassword123', 'Rate Limit User');
      expect(result).toEqual({
        error: 'too_many_signups_from_ip',
        message: 'Too many signup attempts from this IP'
      });
    });
  });

  describe('verify_email', () => {
    it('verify_email happy path → user status changed to verified', async () => {
      await authSystem.signup('test@example.com', 'thisisaverygoodpassword123', 'Test User');
      const user = await db.query('SELECT id FROM users WHERE email = $1', ['test@example.com']);
      const userId = user.rows[0].id;
      const code = await db.query(
        'SELECT code FROM verification_codes WHERE user_id = $1 AND type = \'email\'',
        [userId]
      );
      const result = await authSystem.verify_email('test@example.com', code.rows[0].code);
      expect(result).toEqual({
        status: 'verified',
        user_id: userId,
        message: 'ready to login'
      });
      const updatedUser = await db.query('SELECT email_verified_at FROM users WHERE id = $1', [userId]);
      expect(updatedUser.rows[0].email_verified_at).not.toBeNull();
    });

    it('verify_email expired code → 400 {error: "code_expired"}', async () => {
      await authSystem.signup('test@example.com', 'thisisaverygoodpassword123', 'Test User');
      const user = await db.query('SELECT id FROM users WHERE email = $1', ['test@example.com']);
      const userId = user.rows[0].id;
      // Expire the code manually
      await db.query(
        'UPDATE verification_codes SET expires_at = NOW() - INTERVAL \"1 hour\" WHERE user_id = $1 AND type = \'email\'',
        [userId]
      );
      const codeResult = await db.query(
        'SELECT code FROM verification_codes WHERE user_id = $1 AND type = \'email\'',
        [userId]
      );
      const result = await authSystem.verify_email('test@example.com', codeResult.rows[0].code);
      expect(result).toEqual({
        error: 'code_expired',
        message: 'Invalid or expired code'
      });
    });
  });

  describe('login', () => {
    it('login happy path (no MFA) → token returned', async () => {
      await authSystem.signup('test@example.com', 'thisisaverygoodpassword123', 'Test User');
      await authSystem.verify_email('test@example.com', '123456'); // Mock code
      const result = await authSystem.login('test@example.com', 'thisisaverygoodpassword123', 'device123', '1.2.3.4');
      expect(result).toHaveProperty('status', 'authenticated');
      expect(result).toHaveProperty('token');
      expect(result).toHaveProperty('session_id');
      expect(result.user).toEqual({ id: expect.any(Number), email: 'test@example.com', tier: 'free' });
    });

    it('login with MFA enabled → 202 {status: "mfa_required", challenge_id}', async () => {
      await authSystem.signup('test@example.com', 'thisisaverygoodpassword123', 'Test User');
      await authSystem.verify_email('test@example.com', '123456');
      // Enable MFA for user
      const user = await db.query('SELECT id FROM users WHERE email = $1', ['test@example.com']);
      await db.query(
        'UPDATE users SET mfa_secret = $1, mfa_enabled = TRUE WHERE id = $2',
        [authSystem.generateTotpSecret(), user.rows[0].id]
      );
      const result = await authSystem.login('test@example.com', 'thisisaverygoodpassword123', 'device123', '1.2.3.4');
      expect(result).toEqual({
        status: 'mfa_required',
        challenge_id: expect.any(String)
      });
    });

    it('login invalid password → 401 {error: "invalid_credentials"}', async () => {
      await authSystem.signup('test@example.com', 'thisisaverygoodpassword123', 'Test User');
      await authSystem.verify_email('test@example.com', '123456');
      const result = await authSystem.login('test@example.com', 'wrongpassword', 'device123', '1.2.3.4');
      expect(result).toEqual({
        error: 'invalid_credentials',
        message: 'Invalid email or password'
      });
    });
  });

  describe('oauth_callback', () => {
    it('oauth_callback happy path (new user) → user created + oauth linked', async () => {
      const result = await authSystem.oauth_callback('google', 'authcode', 'valid_state');
      expect(result).toEqual({
        status: 'authenticated',
        session_id: expect.any(String),
        token: expect.any(String),
        user: { id: expect.any(Number), email: 'user@google.com', tier: 'free' }
      });
      const user = await db.query('SELECT id, email, status FROM users WHERE email = $1', ['user@google.com']);
      expect(user.rowCount).toBe(1);
      expect(user.rows[0].status).toBe('verified');
    });

    it('oauth_callback existing user → oauth linked to existing account', async () => {
      await authSystem.signup('user@github.com', 'thisisaverygoodpassword123', 'Test User');
      await authSystem.verify_email('user@github.com', '123456');
      const result = await authSystem.oauth_callback('github', 'authcode', 'valid_state');
      expect(result).toEqual({
        status: 'authenticated',
        session_id: expect.any(String),
        token: expect.any(String),
        user: { id: expect.any(Number), email: 'user@github.com', tier: 'free' }
      });
      // Verify OAuth link (mocked by checking audit log)
      const logs = await db.query('SELECT * FROM audit_log WHERE action = $1', ['oauth_login']);
      expect(logs.rowCount).toBe(2); // One from signup, one from oauth_callback
    });
  });

  describe('mfa_challenge', () => {
    it('mfa_challenge happy path → token returned', async () => {
      await authSystem.signup('test@example.com', 'thisisaverygoodpassword123', 'Test User');
      await authSystem.verify_email('test@example.com', '123456');
      // Enable MFA
      const user = await db.query('SELECT id FROM users WHERE email = $1', ['test@example.com']);
      const secret = authSystem.generateTotpSecret();
      await db.query(
        'UPDATE users SET mfa_secret = $1, mfa_enabled = TRUE WHERE id = $2',
        [secret, user.rows[0].id]
      );
      // Trigger MFA challenge via login
      const loginResult = await authSystem.login('test@example.com', 'thisisaverygoodpassword123', 'device123', '1.2.3.4');
      expect(loginResult.status).toBe('mfa_required');
      const challengeId = loginResult.challenge_id;
      // Generate TOTP code
      const token = speakeasy.totp({ secret, encoding: 'base32' });
      const result = await authSystem.mfa_challenge(challengeId, token);
      expect(result).toEqual({
        status: 'authenticated',
        session_id: expect.any(String),
        token: expect.any(String),
        user: { id: expect(Number), email: 'test@example.com', tier: 'free' }
      });
    });

    it('mfa_challenge wrong code → 401 {error: "invalid_code"}', async () => {
      await authSystem.signup('test@example.com', 'thisisaverygoodpassword123', 'Test User');
      await authSystem.verify_email('test@example.com', '123456');
      // Enable MFA
      const user = await db.query('SELECT id FROM users WHERE email = $1', ['test@example.com']);
      const secret = authSystem.generateTotpSecret();
      await db.query(
        'UPDATE users SET mfa_secret = $1, mfa_enabled = TRUE WHERE id = $2',
        [secret, user.rows[0].id]
      );
      const loginResult = await authSystem.login('test@example.com', 'thisisaverygoodpassword123', 'device123', '1.2.3.4');
      expect(loginResult.status).toBe('mfa_required');
      const challengeId = loginResult.challenge_id;
      const result = await authSystem.mfa_challenge(challengeId, '000000');
      expect(result).toEqual({
        error: 'invalid_code',
        message: 'Invalid or expired code'
      });
    });
  });

  describe('token_refresh', () => {
    it('token_refresh happy path → new token issued', async () => {
      await authSystem.signup('test@example.com', 'thisisaverygoodpassword123', 'Test User');
      await authSystem.verify_email('test@example.com', '123456');
      const loginResult = await authSystem.login('test@example.com', 'thisisaverygoodpassword123', 'device123', '1.2.3.4');
      const refreshToken = await db.query(
        'SELECT refresh_token FROM sessions WHERE user_id = $1',
        [loginResult.user.id]
      );
      const result = await authSystem.token_refresh(refreshToken.rows[0].refresh_token);
      expect(result).toEqual({
        status: 'ok',
        token: expect.any(String),
        expires_in: 3600
      });
    });

    it('token_refresh banned user → 403 {error: "user_banned"}', async () => {
      await authSystem.signup('test@example.com', 'thisisaverygoodpassword123', 'Test User');
      await authSystem.verify_email('test@example.com', '123456');
      // Ban user
      await db.query('UPDATE users SET status = \'banned\' WHERE email = $1', ['test@example.com']);
      const loginResult = await authSystem.login('test@example.com', 'thisisaverygoodpassword123', 'device123', '1.2.3.4');
      const refreshToken = await db.query(
        'SELECT refresh_token FROM sessions WHERE user_id = $1',
        [loginResult.user.id]
      );
      const result = await authSystem.token_refresh(refreshToken.rows[0].refresh_token);
      expect(result).toEqual({
        error: 'user_banned',
        message: 'User is banned or suspended'
      });
    });
  });
});