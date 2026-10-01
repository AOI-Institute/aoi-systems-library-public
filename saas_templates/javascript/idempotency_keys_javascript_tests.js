const { test } = require('node:test');
const assert = require('node:assert');
const {
  InMemoryStore,
  SqliteStore,
  computeFingerprint,
  isRequired,
  handle,
  purgeExpired,
  problemResponse
} = require('./idempotency_keys_javascript.js');

let operationCallCount;

async function makeOperation(status = 200, body = { ok: true }) {
  operationCallCount++;
  return { status, body };
}

async function makeFailingOperation() {
  operationCallCount++;
  throw new Error('Operation failed');
}

function createConfig(store, overrides = {}) {
  return { store, ...overrides };
}

test('first call runs the operation once', async () => {
  const store = new InMemoryStore();
  operationCallCount = 0;

  const result = await handle('user1', 'key-1', 'POST', '/api/resource', { data: 'test' }, () => makeOperation(201, { id: 1 }), createConfig(store));

  assert.strictEqual(result.status, 201);
  assert.strictEqual(result.content_type, 'application/json');
  assert.deepStrictEqual(JSON.parse(result.body), { id: 1 });
  assert.strictEqual(operationCallCount, 1);
});

test('second identical call returns stored response and operation count stays at 1', async () => {
  const store = new InMemoryStore();
  operationCallCount = 0;

  await handle('user1', 'key-2', 'POST', '/api/resource', { data: 'test' }, () => makeOperation(201, { id: 2 }), createConfig(store));
  const result = await handle('user1', 'key-2', 'POST', '/api/resource', { data: 'test' }, () => makeOperation(201, { id: 999 }), createConfig(store));

  assert.strictEqual(result.status, 201);
  assert.deepStrictEqual(JSON.parse(result.body), { id: 2 });
  assert.strictEqual(operationCallCount, 1);
});

test('same key different body returns 422', async () => {
  const store = new InMemoryStore();
  operationCallCount = 0;

  await handle('user1', 'key-3', 'POST', '/api/resource', { data: 'first' }, () => makeOperation(201, { id: 3 }), createConfig(store));
  const result = await handle('user1', 'key-3', 'POST', '/api/resource', { data: 'second' }, () => makeOperation(201, { id: 999 }), createConfig(store));

  assert.strictEqual(result.status, 422);
  assert.strictEqual(result.content_type, 'application/problem+json');
  const body = JSON.parse(result.body);
  assert.ok(body.type.includes('unprocessable-content'));
  assert.strictEqual(operationCallCount, 1);
});

test('same key while first is in progress returns 409', async () => {
  const store = new InMemoryStore();
  operationCallCount = 0;

  let resolveFirst;
  const firstPromise = handle('user1', 'key-4', 'POST', '/api/resource', { data: 'test' }, () => new Promise((resolve) => {
    resolveFirst = () => resolve(makeOperation(201, { id: 4 }));
  }), createConfig(store));

  const secondResult = await handle('user1', 'key-4', 'POST', '/api/resource', { data: 'test' }, () => makeOperation(201, { id: 999 }), createConfig(store));

  assert.strictEqual(secondResult.status, 409);
  assert.strictEqual(secondResult.content_type, 'application/problem+json');
  const body = JSON.parse(secondResult.body);
  assert.ok(body.type.includes('conflict'));

  resolveFirst();
  await firstPromise;
  assert.strictEqual(operationCallCount, 1);
});

test('required operation with no key returns 400', async () => {
  const store = new InMemoryStore();
  operationCallCount = 0;

  const result = await handle('user1', null, 'POST', '/api/resource', { data: 'test' }, () => makeOperation(201, { id: 5 }), createConfig(store));

  assert.strictEqual(result.status, 400);
  assert.strictEqual(result.content_type, 'application/problem+json');
  const body = JSON.parse(result.body);
  assert.ok(body.type.includes('missing-idempotency-key'));
  assert.strictEqual(operationCallCount, 0);
});

test('same key under two different scopes runs twice independently', async () => {
  const store = new InMemoryStore();
  operationCallCount = 0;

  await handle('user1', 'shared-key', 'POST', '/api/resource', { data: 'user1' }, () => makeOperation(201, { id: 101 }), createConfig(store));
  await handle('user2', 'shared-key', 'POST', '/api/resource', { data: 'user2' }, () => makeOperation(201, { id: 102 }), createConfig(store));

  assert.strictEqual(operationCallCount, 2);
});

test('expired key runs the operation again', async () => {
  const store = new InMemoryStore();
  operationCallCount = 0;

  const shortTtlConfig = createConfig(store, { ttlMs: 1 });
  await handle('user1', 'key-expired', 'POST', '/api/resource', { data: 'test' }, () => makeOperation(201, { id: 6 }), shortTtlConfig);

  await new Promise(r => setTimeout(r, 10));

  const result = await handle('user1', 'key-expired', 'POST', '/api/resource', { data: 'test' }, () => makeOperation(201, { id: 7 }), shortTtlConfig);

  assert.strictEqual(result.status, 201);
  assert.deepStrictEqual(JSON.parse(result.body), { id: 7 });
  assert.strictEqual(operationCallCount, 2);
});

test('operation that throws frees the key: retry runs the operation', async () => {
  const store = new InMemoryStore();
  operationCallCount = 0;

  try {
    await handle('user1', 'key-error', 'POST', '/api/resource', { data: 'test' }, () => makeFailingOperation(), createConfig(store));
    assert.fail('Expected operation to throw');
  } catch (e) {
    assert.strictEqual(e.message, 'Operation failed');
  }

  assert.strictEqual(operationCallCount, 1);

  const result = await handle('user1', 'key-error', 'POST', '/api/resource', { data: 'test' }, () => makeOperation(201, { id: 8 }), createConfig(store));

  assert.strictEqual(result.status, 201);
  assert.deepStrictEqual(JSON.parse(result.body), { id: 8 });
  assert.strictEqual(operationCallCount, 2);
});

test('error responses carry content_type application/problem+json and body with type title detail', async () => {
  const store = new InMemoryStore();
  operationCallCount = 0;

  const missingKeyResult = await handle('user1', null, 'POST', '/api/resource', { data: 'test' }, () => makeOperation(201, { id: 9 }), createConfig(store));
  assert.strictEqual(missingKeyResult.content_type, 'application/problem+json');
  const missingKeyBody = JSON.parse(missingKeyResult.body);
  assert.ok(missingKeyBody.type);
  assert.ok(missingKeyBody.title);
  assert.ok(missingKeyBody.detail);

  await handle('user1', 'key-err2', 'POST', '/api/resource', { data: 'first' }, () => makeOperation(201, { id: 9 }), createConfig(store));
  const mismatchResult = await handle('user1', 'key-err2', 'POST', '/api/resource', { data: 'second' }, () => makeOperation(201, { id: 999 }), createConfig(store));
  assert.strictEqual(mismatchResult.content_type, 'application/problem+json');
  const mismatchBody = JSON.parse(mismatchResult.body);
  assert.ok(mismatchBody.type);
  assert.ok(mismatchBody.title);
  assert.ok(mismatchBody.detail);

  let resolveFirst;
  const firstPromise = handle('user1', 'key-err3', 'POST', '/api/resource', { data: 'test' }, () => new Promise((resolve) => {
    resolveFirst = () => resolve(makeOperation(201, { id: 9 }));
  }), createConfig(store));
  const inProgressResult = await handle('user1', 'key-err3', 'POST', '/api/resource', { data: 'test' }, () => makeOperation(201, { id: 999 }), createConfig(store));
  assert.strictEqual(inProgressResult.content_type, 'application/problem+json');
  const inProgressBody = JSON.parse(inProgressResult.body);
  assert.ok(inProgressBody.type);
  assert.ok(inProgressBody.title);
  assert.ok(inProgressBody.detail);
  resolveFirst();
  await firstPromise;
});

test('isRequired returns true for POST and PATCH by default', () => {
  assert.strictEqual(isRequired('POST', '/api/resource'), true);
  assert.strictEqual(isRequired('PATCH', '/api/resource'), true);
  assert.strictEqual(isRequired('GET', '/api/resource'), false);
  assert.strictEqual(isRequired('PUT', '/api/resource'), false);
  assert.strictEqual(isRequired('DELETE', '/api/resource'), false);
});

test('isRequired respects custom config', () => {
  const config = { idempotentMethods: new Set(['POST', 'PUT']) };
  assert.strictEqual(isRequired('POST', '/api/resource', config), true);
  assert.strictEqual(isRequired('PUT', '/api/resource', config), true);
  assert.strictEqual(isRequired('PATCH', '/api/resource', config), false);
});

test('computeFingerprint produces consistent hashes', () => {
  const fp1 = computeFingerprint('POST', '/api/resource', { a: 1 });
  const fp2 = computeFingerprint('POST', '/api/resource', { a: 1 });
  const fp3 = computeFingerprint('POST', '/api/resource', { a: 2 });
  assert.strictEqual(fp1, fp2);
  assert.notStrictEqual(fp1, fp3);
  assert.strictEqual(fp1.length, 64);
});

test('SqliteStore works correctly', async () => {
  const store = new SqliteStore(':memory:');
  operationCallCount = 0;

  const result = await handle('user1', 'sqlite-key', 'POST', '/api/resource', { data: 'test' }, () => makeOperation(201, { id: 10 }), createConfig(store));
  assert.strictEqual(result.status, 201);
  assert.deepStrictEqual(JSON.parse(result.body), { id: 10 });
  assert.strictEqual(operationCallCount, 1);

  const cached = await handle('user1', 'sqlite-key', 'POST', '/api/resource', { data: 'test' }, () => makeOperation(201, { id: 999 }), createConfig(store));
  assert.strictEqual(cached.status, 201);
  assert.deepStrictEqual(JSON.parse(cached.body), { id: 10 });
  assert.strictEqual(operationCallCount, 1);

  store.close();
});

test('purgeExpired removes expired records', async () => {
  const store = new InMemoryStore();
  operationCallCount = 0;

  const shortTtlConfig = createConfig(store, { ttlMs: 1 });
  await handle('user1', 'key-purge', 'POST', '/api/resource', { data: 'test' }, () => makeOperation(201, { id: 11 }), shortTtlConfig);

  await new Promise(r => setTimeout(r, 10));

  await purgeExpired(shortTtlConfig);

  const result = await handle('user1', 'key-purge', 'POST', '/api/resource', { data: 'test' }, () => makeOperation(201, { id: 12 }), shortTtlConfig);
  assert.strictEqual(result.status, 201);
  assert.deepStrictEqual(JSON.parse(result.body), { id: 12 });
  assert.strictEqual(operationCallCount, 2);
});

test('non-idempotent method without key runs operation', async () => {
  const store = new InMemoryStore();
  operationCallCount = 0;

  const result = await handle('user1', null, 'GET', '/api/resource', null, () => makeOperation(200, { data: 'ok' }), createConfig(store));

  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(JSON.parse(result.body), { data: 'ok' });
  assert.strictEqual(operationCallCount, 1);
});