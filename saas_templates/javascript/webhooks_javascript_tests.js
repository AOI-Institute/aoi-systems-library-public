const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  create_endpoint,
  send_event,
  sign,
  verify,
  rotate_secret,
  deliver,
  _store,
} = require('./webhooks_javascript.js');

/* Helper fake sender ------------------------------------------------------ */
function makeSender(responses) {
  let i = 0;
  return async (url, headers, body) => {
    const resp = responses[i++] || { status: 200 };
    // mimic async network latency
    await new Promise(r => setTimeout(r, 1));
    return resp;
  };
}

/* 1. sign then verify round‑trip */
test('sign then verify round‑trip', async () => {
  const { id, secret } = create_endpoint('org1', 'https://example.com', ['ev']);
  const msgId = 'msg_test';
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ hello: 'world' });
  const sig = sign(secret, msgId, ts, body);
  const headers = {
    'webhook-id': msgId,
    'webhook-timestamp': ts.toString(),
    'webhook-signature': sig,
  };
  const result = verify(secret, headers, body);
  assert.strictEqual(result, true);
});

/* 2. changed body fails verify */
test('changed body fails verify', async () => {
  const { secret } = create_endpoint('org1', 'https://example.com', ['ev']);
  const msgId = 'msg_test2';
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ a: 1 });
  const sig = sign(secret, msgId, ts, body);
  const headers = {
    'webhook-id': msgId,
    'webhook-timestamp': ts.toString(),
    'webhook-signature': sig,
  };
  const badBody = JSON.stringify({ a: 2 });
  const result = verify(secret, headers, badBody);
  assert.strictEqual(result, 'signature mismatch');
});

/* 3. changed timestamp fails verify */
test('changed timestamp fails verify', async () => {
  const { secret } = create_endpoint('org1', 'https://example.com', ['ev']);
  const msgId = 'msg_test3';
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ a: 1 });
  const sig = sign(secret, msgId, ts, body);
  const headers = {
    'webhook-id': msgId,
    'webhook-timestamp': (ts + 10).toString(),
    'webhook-signature': sig,
  };
  const result = verify(secret, headers, body);
  assert.strictEqual(result, 'signature mismatch');
});

/* 4. timestamp older than tolerance rejected */
test('timestamp older than tolerance rejected', async () => {
  const { secret } = create_endpoint('org1', 'https://example.com', ['ev']);
  const msgId = 'msg_test4';
  const ts = Math.floor(Date.now() / 1000) - 1000; // >300 seconds ago
  const body = JSON.stringify({ a: 1 });
  const sig = sign(secret, msgId, ts, body);
  const headers = {
    'webhook-id': msgId,
    'webhook-timestamp': ts.toString(),
    'webhook-signature': sig,
  };
  const result = verify(secret, headers, body);
  assert.strictEqual(result, 'timestamp outside tolerance');
});

/* 5. verify accepts when one of two signatures matches */
test('verify accepts when one of two signatures matches', async () => {
  const { secret } = create_endpoint('org1', 'https://example.com', ['ev']);
  const msgId = 'msg_test5';
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ a: 1 });
  const goodSig = sign(secret, msgId, ts, body);
  const badSig = 'v1,invalidsignature';
  const headers = {
    'webhook-id': msgId,
    'webhook-timestamp': ts.toString(),
    'webhook-signature': `${goodSig} ${badSig}`,
  };
  const result = verify(secret, headers, body);
  assert.strictEqual(result, true);
});

/* 6. delivery success and retry scheduling */
test('delivery success and retry scheduling', async () => {
  const ep = create_endpoint('org1', 'https://example.com', ['ev']);
  const msgId = send_event('org1', 'ev', { data: 123 });
  // find the delivery created
  const delivery = Array.from(_store.deliveries.values()).find(d => d.message_id === msgId);
  // first attempt: 200 success
  const sender1 = makeSender([{ status: 200 }]);
  const res1 = await deliver(delivery, sender1);
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.attempt, 1);
  // second attempt: 301 (should schedule retry)
  const sender2 = makeSender([{ status: 301 }]);
  const res2 = await deliver(delivery, sender2);
  assert.strictEqual(res2.success, false);
  assert.strictEqual(res2.attempt, 2);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(res2.next_attempt_at > now);
});

/* 7. org isolation */
test('event for org A does not create delivery for org B', async () => {
  const epA = create_endpoint('orgA', 'https://a.com', ['ev']);
  const epB = create_endpoint('orgB', 'https://b.com', ['ev']);
  const msgId = send_event('orgA', 'ev', { foo: 'bar' });
  const deliveries = Array.from(_store.deliveries.values()).filter(d => d.message_id === msgId);
  assert.strictEqual(deliveries.length, 1);
  const del = deliveries[0];
  const endpoint = _store.getEndpoint(del.endpoint_id);
  assert.strictEqual(endpoint.org_id, 'orgA');
});

/* 8. webhook-id identical across retries */
test('webhook-id stays identical across retries', async () => {
  const ep = create_endpoint('org1', 'https://example.com', ['ev']);
  const msgId = send_event('org1', 'ev', { x: 1 });
  const delivery = Array.from(_store.deliveries.values()).find(d => d.message_id === msgId);
  const sender = makeSender([{ status: 400 }, { status: 200 }]);
  const first = await deliver(delivery, sender);
  const firstId = first.id;
  const second = await deliver(delivery, sender);
  const secondId = second.id;
  assert.strictEqual(firstId, secondId);
});

/* 9. generated secret format */
test('generated secret starts with whsec_ and decodes to 24‑64 bytes', async () => {
  const { secret } = create_endpoint('org1', 'https://example.com', ['ev']);
  assert.ok(secret.startsWith('whsec_'));
  const decoded = Buffer.from(secret.slice(5), 'base64');
  assert.ok(decoded.length >= 24 && decoded.length <= 64);
});