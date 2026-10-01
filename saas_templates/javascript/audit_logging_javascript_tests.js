const assert = require('assert');
const { AuditLogger } = require('./audit_logging_javascript.js');

async function runTests() {
  console.log("Starting Audit Logging Test Suite...");

  // 1. Happy path: log mutation, query it back
  {
    console.log("Running: Happy path...");
    const logger = new AuditLogger();
    const logData = {
      actor_id: 123,
      actor_type: 'user',
      action: 'subscription_changed',
      resource_type: 'subscription',
      resource_id: 456,
      old_value: { tier: 'team', billing_date: '2026-10-15' },
      new_value: { tier: 'enterprise', billing_date: '2026-10-15' },
      why_chain_id: 'wc_789',
      metadata: { ip: '127.0.0.1', user_agent: 'Mozilla/5.0' }
    };

    const res = await logger.logMutation(logData);
    assert.strictEqual(res.success, true);
    assert.strictEqual(typeof res.log_id, 'string');

    const queryRes = await logger.queryLogs({ actor_id: 123 });
    assert.strictEqual(queryRes.logs.length, 1);
    assert.strictEqual(queryRes.logs[0].id, res.log_id);
    assert.strictEqual(queryRes.logs[0].action, 'subscription_changed');
    assert.deepStrictEqual(queryRes.logs[0].old_value, logData.old_value);
    assert.deepStrictEqual(queryRes.logs[0].new_value, logData.new_value);
  }

  // 2. Replay: divergence detection (state changed since log)
  {
    console.log("Running: Replay & Divergence Detection...");
    const logger = new AuditLogger();
    
    const log1 = await logger.logMutation({
      actor_id: 123,
      actor_type: 'user',
      action: 'user_created',
      resource_type: 'user',
      resource_id: 'user_999',
      old_value: null,
      new_value: { status: 'active', email: 'test@example.com' }
    });

    const replay1 = await logger.replay(log1.log_id);
    assert.strictEqual(replay1.has_diverged, false);
    assert.strictEqual(replay1.resource_state_at_time, null);

    await logger.logMutation({
      actor_id: 123,
      actor_type: 'user',
      action: 'user_suspended',
      resource_type: 'user',
      resource_id: 'user_999',
      old_value: { status: 'active', email: 'test@example.com' },
      new_value: { status: 'suspended', email: 'test@example.com' }
    });

    const replay2 = await logger.replay(log1.log_id);
    assert.strictEqual(replay2.has_diverged, true);

    const replay3 = await logger.replay(log1.log_id, { status: 'active', email: 'test@example.com' });
    assert.strictEqual(replay3.has_diverged, true);
  }

  // 3. Filtering: actor_id + action + resource_type work together
  {
    console.log("Running: Filtering...");
    const logger = new AuditLogger();
    await logger.logMutation({ actor_id: 'user_a', actor_type: 'user', action: 'user_created', resource_type: 'user', resource_id: '1' });
    await logger.logMutation({ actor_id: 'user_b', actor_type: 'user', action: 'user_suspended', resource_type: 'user', resource_id: '2' });
    await logger.logMutation({ actor_id: 'user_a', actor_type: 'user', action: 'billing_changed', resource_type: 'billing', resource_id: '3' });

    const filterRes = await logger.queryLogs({ actor_id: 'user_a', resource_type: 'user' });
    assert.strictEqual(filterRes.logs.length, 1);
    assert.strictEqual(filterRes.logs[0].action, 'user_created');
  }

  // 4. Pagination: limit/offset work
  {
    console.log("Running: Pagination...");
    const logger = new AuditLogger();
    for (let i = 0; i < 15; i++) {
      await logger.logMutation({
        actor_id: 'paginator',
        actor_type: 'user',
        action: 'item_created',
        resource_type: 'item',
        resource_id: String(i)
      });
    }

    const page1 = await logger.queryLogs({ actor_id: 'paginator', limit: 10, offset: 0 });
    assert.strictEqual(page1.logs.length, 10);
    assert.strictEqual(page1.has_more, true);
    assert.strictEqual(page1.total, 15);

    const page2 = await logger.queryLogs({ actor_id: 'paginator', limit: 10, offset: 10 });
    assert.strictEqual(page2.logs.length, 5);
    assert.strictEqual(page2.has_more, false);
  }

  // 5. Performance: 1M+ logs, queries return <100ms
  {
    console.log("Running: Performance (1M+ logs)...");
    const perfLogger = new AuditLogger();
    const batchSize = 1000000;
    const mockLogs = [];
    const baseTime = Date.now();

    for (let i = 0; i < batchSize; i++) {
      const actorId = `user_${i % 1000}`;
      const action = i % 2 === 0 ? 'user_created' : 'user_suspended';
      const resourceType = 'user';
      const resourceId = `res_${i}`;
      const timestamp = new Date(baseTime - i * 1000).toISOString();

      const log = {
        id: `uuid_${i}`,
        timestamp,
        actor_id: actorId,
        actor_type: 'user',
        action,
        resource_type: resourceType,
        resource_id: resourceId,
        old_value: null,
        new_value: { index: i },
        why_chain_id: null,
        metadata: null
      };
      Object.freeze(log);
      mockLogs.push(log);
    }

    perfLogger.logs = mockLogs;
    for (let i = 0; i < mockLogs.length; i++) {
      const log = mockLogs[i];
      perfLogger.indexById.set(log.id, log);

      const actorKey = String(log.actor_id);
      if (!perfLogger.indexByActor.has(actorKey)) perfLogger.indexByActor.set(actorKey, []);
      perfLogger.indexByActor.get(actorKey).push(log);

      if (!perfLogger.indexByAction.has(log.action)) perfLogger.indexByAction.set(log.action, []);
      perfLogger.indexByAction.get(log.action).push(log);

      if (!perfLogger.indexByResourceType.has(log.resource_type)) perfLogger.indexByResourceType.set(log.resource_type, []);
      perfLogger.indexByResourceType.get(log.resource_type).push(log);
    }

    const queryStart = Date.now();
    const queryRes = await perfLogger.queryLogs({
      actor_id: 'user_500',
      action: 'user_created',
      resource_type: 'user',
      limit: 50
    });
    const queryDuration = Date.now() - queryStart;
    console.log(`Query returned ${queryRes.logs.length} results in ${queryDuration}ms`);
    assert.ok(queryDuration < 100, `Query took too long: ${queryDuration}ms`);
  }

  // 6. Immutability: UPDATE on log returns error
  {
    console.log("Running: Immutability...");
    const logger = new AuditLogger();
    const log = await logger.logMutation({
      actor_id: 'system',
      actor_type: 'service',
      action: 'system_init',
      resource_type: 'system',
      resource_id: '0'
    });

    let threwError = false;
    try {
      await logger.updateLog(log.log_id, { action: 'hacked' });
    } catch (err) {
      threwError = true;
      assert.ok(err.message.includes("immutable"));
    }
    assert.strictEqual(threwError, true, "Expected update to throw an error due to immutability");

    let threwDeleteError = false;
    try {
      await logger.deleteLog(log.log_id);
    } catch (err) {
      threwDeleteError = true;
      assert.ok(err.message.includes("immutable"));
    }
    assert.strictEqual(threwDeleteError, true, "Expected delete to throw an error due to immutability");
  }

  // 7. Wildcard: action='user_*' matches user_created, user_suspended, etc.
  {
    console.log("Running: Wildcard Matching...");
    const logger = new AuditLogger();
    await logger.logMutation({ actor_id: 1, actor_type: 'user', action: 'user_created', resource_type: 'user', resource_id: '1' });
    await logger.logMutation({ actor_id: 1, actor_type: 'user', action: 'user_suspended', resource_type: 'user', resource_id: '2' });
    await logger.logMutation({ actor_id: 1, actor_type: 'user', action: 'billing_changed', resource_type: 'billing', resource_id: '3' });

    const wildcardRes = await logger.queryLogs({ action: 'user_*' });
    assert.strictEqual(wildcardRes.logs.length, 2);
    const actions = wildcardRes.logs.map(l => l.action);
    assert.ok(actions.includes('user_created'));
    assert.ok(actions.includes('user_suspended'));
    assert.ok(!actions.includes('billing_changed'));
  }

  console.log("All tests passed successfully!");
}

runTests().catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});