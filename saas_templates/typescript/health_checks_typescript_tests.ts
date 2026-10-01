/**
 * Test suite for health_checks_typescript.ts
 *
 * Run with:  node health_checks_typescript_tests.ts
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  register_check,
  liveness,
  readiness,
  resetChecks,
} = require('./health_checks_typescript.ts');

describe('Health Checks – TypeScript implementation', () => {
  // Ensure a clean registry before each test.
  test('setup – clear registry', () => {
    resetChecks();
    // No assertions – just preparation.
  });

  test('all checks pass → 200, status "pass"', async () => {
    resetChecks();
    register_check('db', 'postgres', () => {}, true, 100);
    register_check('cache', 'redis', () => {}, false, 100);

    const resp = await readiness();
    assert.strictEqual(resp.http_status, 200);
    assert.strictEqual(resp.content_type, 'application/health+json');

    const body = JSON.parse(resp.body);
    assert.strictEqual(body.status, 'pass');
    // Ensure checks object exists and each entry reports pass.
    for (const key in body.checks) {
      for (const entry of body.checks[key]) {
        assert.strictEqual(entry.status, 'pass');
      }
    }
  });

  test('critical check fails → 503, status "fail"', async () => {
    resetChecks();
    register_check('db', 'postgres', () => {
      throw new Error('db down');
    }, true, 100);

    const resp = await readiness();
    assert.strictEqual(resp.http_status, 503);
    const body = JSON.parse(resp.body);
    assert.strictEqual(body.status, 'fail');
    // The failing check should be present.
    const key = 'db:postgres';
    assert.ok(body.checks[key]);
    assert.strictEqual(body.checks[key][0].status, 'fail');
  });

  test('non‑critical check fails → 200, status "warn"', async () => {
    resetChecks();
    // Critical passing check.
    register_check('db', 'postgres', () => {}, true, 100);
    // Non‑critical failing check.
    register_check('cache', 'redis', () => {
      return { status: 'fail' };
    }, false, 100);

    const resp = await readiness();
    assert.strictEqual(resp.http_status, 200);
    const body = JSON.parse(resp.body);
    assert.strictEqual(body.status, 'warn');
    // Verify the non‑critical check is reported as fail.
    const key = 'cache:redis';
    assert.ok(body.checks[key]);
    assert.strictEqual(body.checks[key][0].status, 'fail');
  });

  test('slow check exceeding timeout → that check fails', async () => {
    resetChecks();
    // Slow non‑critical check (timeout 50 ms).
    register_check('slow', 'service', async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { status: 'pass' };
    }, false, 50);

    const resp = await readiness();
    const body = JSON.parse(resp.body);
    // Overall status should be warn because the only failing check is non‑critical.
    assert.strictEqual(body.status, 'warn');
    const key = 'slow:service';
    assert.ok(body.checks[key]);
    assert.strictEqual(body.checks[key][0].status, 'fail');
  });

  test('liveness stays pass even when a dependency check fails', async () => {
    resetChecks();
    register_check('db', 'postgres', () => {
      throw new Error('down');
    }, true, 100);

    const live = liveness();
    assert.strictEqual(live.http_status, 200);
    const liveBody = JSON.parse(live.body);
    assert.strictEqual(liveBody.status, 'pass');
  });

  test('output contains no connection string', async () => {
    resetChecks();
    register_check('db', 'postgres', () => {}, true, 100);
    const resp = await readiness();
    assert.ok(!resp.body.includes('connection'), 'Response body should not contain the word "connection"');
  });
});