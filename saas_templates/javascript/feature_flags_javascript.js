const crypto = require('node:crypto');

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS feature_flags (
    key TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('boolean','string','number','object')),
    default_value TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
    rules TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS flag_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flag_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create','update')),
    old_value TEXT,
    new_value TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS flag_audit_by_key ON flag_audit (flag_key, id)`
];

class FeatureFlagError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'FeatureFlagError';
    this.code = code;
    this.status = status;
  }
}

function stableBucket(flagKey, targetingKey) {
  const hashBytes = crypto.createHash('sha256').update(flagKey + ":" + targetingKey).digest();
  let bucket = 0; for (let i = 0; i < 8; i++) { bucket = (bucket * 256 + hashBytes[i]) % 100; }
  return bucket;
}

function makeSnapshot(type, defaultValueJson, enabled, rulesJson) {
  return '{"type":' + JSON.stringify(type) + ',"default_value":' + defaultValueJson + ',"enabled":' + (enabled ? 'true' : 'false') + ',"rules":' + rulesJson + '}';
}

function checkFinite(val) {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new Error("Non-finite number");
    }
  } else if (val && typeof val === 'object') {
    for (const k of Object.keys(val)) {
      checkFinite(val[k]);
    }
  }
}

function parseJsonStrict(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error("Empty or non-string JSON");
  }
  const parsed = JSON.parse(text);
  checkFinite(parsed);
  return parsed;
}

function parseRules(text) {
  const rules = parseJsonStrict(text);
  if (!Array.isArray(rules)) {
    throw new Error("Rules must be an array");
  }
  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null) {
      throw new Error("Rule must be an object");
    }
    if (!('conditions' in rule) || !Array.isArray(rule.conditions)) {
      throw new Error("Rule conditions must be an array");
    }
    if (!('variant' in rule) || typeof rule.variant !== 'string' || rule.variant === '') {
      throw new Error("Rule variant must be a non-empty string");
    }
    if (!('value' in rule)) {
      throw new Error("Rule value must be present");
    }
    if ('rollout' in rule && rule.rollout !== null) {
      const rollout = rule.rollout;
      if (typeof rollout !== 'object' || rollout === null) {
        throw new Error("Rollout must be an object");
      }
      if (!('percentage' in rollout) || typeof rollout.percentage !== 'number' || rollout.percentage < 0 || rollout.percentage > 100) {
        throw new Error("Rollout percentage must be a number between 0 and 100");
      }
    }
    for (const cond of rule.conditions) {
      if (typeof cond !== 'object' || cond === null) {
        throw new Error("Condition must be an object");
      }
      if (!('attribute' in cond) || typeof cond.attribute !== 'string' || cond.attribute === '') {
        throw new Error("Condition attribute must be a non-empty string");
      }
      if (!('operator' in cond) || !['equals', 'not_equals', 'in_list', 'ends_with'].includes(cond.operator)) {
        throw new Error("Condition operator must be one of equals, not_equals, in_list, ends_with");
      }
      if (!('value' in cond)) {
        throw new Error("Condition value must be present");
      }
      const op = cond.operator;
      const val = cond.value;
      if (op === 'equals' || op === 'not_equals') {
        if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') {
          throw new Error("Condition value for equals/not_equals must be a scalar");
        }
      } else if (op === 'in_list') {
        if (!Array.isArray(val)) {
          throw new Error("Condition value for in_list must be an array");
        }
        for (const item of val) {
          if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
            throw new Error("Condition in_list items must be scalars");
          }
        }
      } else if (op === 'ends_with') {
        if (typeof val !== 'string') {
          throw new Error("Condition value for ends_with must be a string");
        }
      }
    }
  }
  return rules;
}

function scalarEqual(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    return a === b;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b;
  }
  return false;
}

function conditionMatches(c, ctx) {
  if (!Object.hasOwn(ctx, c.attribute)) {
    return false;
  }
  const x = ctx[c.attribute];
  if (x === null || (typeof x !== 'string' && typeof x !== 'number' && typeof x !== 'boolean')) {
    return false;
  }
  const op = c.operator;
  const v = c.value;
  if (op === 'equals') {
    return scalarEqual(x, v);
  }
  if (op === 'not_equals') {
    return !scalarEqual(x, v);
  }
  if (op === 'in_list') {
    return v.some(e => scalarEqual(x, e));
  }
  if (op === 'ends_with') {
    return typeof x === 'string' && x.endsWith(v);
  }
  return false;
}

function getKind(v) {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number' && Number.isFinite(v)) return 'number';
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return 'object';
  return null;
}

function isPlainObject(obj) {
  return obj !== null && typeof obj === 'object' && !Array.isArray(obj);
}

function evaluate(store, flagKey, want, callerDefault, context) {
  try {
    let ctx = context;
    if (ctx === null || ctx === undefined) {
      ctx = {};
    } else if (!isPlainObject(ctx)) {
      return {
        flag_key: flagKey,
        value: callerDefault,
        variant: null,
        reason: 'ERROR',
        error_code: 'GENERAL',
        error_message: 'Context must be a plain object'
      };
    }

    let rec;
    try {
      rec = store.getFlag(flagKey);
    } catch (err) {
      return {
        flag_key: flagKey,
        value: callerDefault,
        variant: null,
        reason: 'ERROR',
        error_code: 'GENERAL',
        error_message: err.message
      };
    }

    if (!rec) {
      return {
        flag_key: flagKey,
        value: callerDefault,
        variant: null,
        reason: 'ERROR',
        error_code: 'FLAG_NOT_FOUND',
        error_message: `Flag not found: ${flagKey}`
      };
    }

    if (rec.type !== want) {
      return {
        flag_key: flagKey,
        value: callerDefault,
        variant: null,
        reason: 'ERROR',
        error_code: 'TYPE_MISMATCH',
        error_message: `Type mismatch: expected ${want}, got ${rec.type}`
      };
    }

    if (!rec.enabled) {
      return {
        flag_key: flagKey,
        value: callerDefault,
        variant: null,
        reason: 'DISABLED',
        error_code: null,
        error_message: null
      };
    }

    let rules, stored;
    try {
      rules = parseRules(rec.rules_json);
      stored = parseJsonStrict(rec.default_value_json);
    } catch (err) {
      return {
        flag_key: flagKey,
        value: callerDefault,
        variant: null,
        reason: 'ERROR',
        error_code: 'PARSE_ERROR',
        error_message: err.message
      };
    }

    let tk = null;
    if (Object.hasOwn(ctx, 'targeting_key') && typeof ctx.targeting_key === 'string' && ctx.targeting_key !== '') {
      tk = ctx.targeting_key;
    }

    for (const rule of rules) {
      let allMatch = true;
      for (const cond of rule.conditions) {
        if (!conditionMatches(cond, ctx)) {
          allMatch = false;
          break;
        }
      }
      if (!allMatch) continue;

      if (!rule.rollout) {
        return serve(rule.value, 'TARGETING_MATCH', rule.variant, rec.type, callerDefault, flagKey);
      }

      if (tk === null) continue;

      const pct = rule.rollout.percentage;
      if (stableBucket(flagKey, tk) < pct) {
        return serve(rule.value, 'SPLIT', rule.variant, rec.type, callerDefault, flagKey);
      }
    }

    return serve(stored, 'DEFAULT', null, rec.type, callerDefault, flagKey);

  } catch (err) {
    return {
      flag_key: flagKey,
      value: callerDefault,
      variant: null,
      reason: 'ERROR',
      error_code: 'GENERAL',
      error_message: err.message
    };
  }
}

function serve(v, reason, variant, expectedType, callerDefault, flagKey) {
  if (getKind(v) !== expectedType) {
    return {
      flag_key: flagKey,
      value: callerDefault,
      variant: null,
      reason: 'ERROR',
      error_code: 'TYPE_MISMATCH',
      error_message: `Served value type mismatch: expected ${expectedType}, got ${getKind(v)}`
    };
  }
  return {
    flag_key: flagKey,
    value: v,
    variant,
    reason,
    error_code: null,
    error_message: null
  };
}

class InMemoryFlagStore {
  constructor() {
    this.flags = new Map();
    this.audit = [];
    this.nextId = 1;
  }

  getFlag(key) {
    const record = this.flags.get(key);
    if (!record) return null;
    return { ...record };
  }

  putFlag(record) {
    this.flags.set(record.key, { ...record });
  }

  saveFlagAudited(record, actorId, at) {
    const previous = this.flags.get(record.key);
    const old_value = previous ? makeSnapshot(previous.type, previous.default_value_json, previous.enabled, previous.rules_json) : null;
    const new_value = makeSnapshot(record.type, record.default_value_json, record.enabled, record.rules_json);
    
    this.flags.set(record.key, { ...record });
    
    const auditEntry = {
      id: this.nextId++,
      flag_key: record.key,
      action: previous ? "update" : "create",
      old_value,
      new_value,
      actor_id: actorId,
      at
    };
    this.audit.push(auditEntry);
    return { ...auditEntry };
  }

  listAudit(flagKey) {
    return this.audit
      .filter(entry => entry.flag_key === flagKey)
      .map(entry => ({ ...entry }))
      .sort((a, b) => a.id - b.id);
  }
}

class SqlFlagStore {
  constructor(db) {
    this.db = db;
    for (const stmt of SCHEMA_STATEMENTS) {
      this.db.exec(stmt);
    }
  }

  getFlag(key) {
    const stmt = this.db.prepare("SELECT key, type, default_value, enabled, rules, updated_at, updated_by FROM feature_flags WHERE key = ?");
    const row = stmt.get(key);
    if (!row) return null;
    return {
      key: row.key,
      type: row.type,
      default_value_json: row.default_value,
      enabled: row.enabled === 1,
      rules_json: row.rules,
      updated_at: row.updated_at,
      updated_by: row.updated_by
    };
  }

  putFlag(record) {
    const stmt = this.db.prepare(`
      INSERT INTO feature_flags (key, type, default_value, enabled, rules, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        type=excluded.type,
        default_value=excluded.default_value,
        enabled=excluded.enabled,
        rules=excluded.rules,
        updated_at=excluded.updated_at,
        updated_by=excluded.updated_by
    `);
    stmt.run(
      record.key,
      record.type,
      record.default_value_json,
      record.enabled ? 1 : 0,
      record.rules_json,
      record.updated_at,
      record.updated_by
    );
  }

  saveFlagAudited(record, actorId, at) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.getFlag(record.key);
      const old_value = previous ? makeSnapshot(previous.type, previous.default_value_json, previous.enabled, previous.rules_json) : null;
      const new_value = makeSnapshot(record.type, record.default_value_json, record.enabled, record.rules_json);

      this.putFlag(record);

      const action = previous ? "update" : "create";
      const auditStmt = this.db.prepare(`
        INSERT INTO flag_audit (flag_key, action, old_value, new_value, actor_id, at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const result = auditStmt.run(
        record.key,
        action,
        old_value,
        new_value,
        actorId,
        at
      );
      const id = Number(result.lastInsertRowid);

      this.db.exec("COMMIT");

      return {
        id,
        flag_key: record.key,
        action,
        old_value,
        new_value,
        actor_id: actorId,
        at
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listAudit(flagKey) {
    const stmt = this.db.prepare("SELECT id, flag_key, action, old_value, new_value, actor_id, at FROM flag_audit WHERE flag_key = ? ORDER BY id ASC");
    const rows = stmt.all(flagKey);
    return rows.map(row => ({
      id: Number(row.id),
      flag_key: row.flag_key,
      action: row.action,
      old_value: row.old_value,
      new_value: row.new_value,
      actor_id: row.actor_id,
      at: Number(row.at)
    }));
  }
}

class FeatureFlagClient {
  constructor(store, options = {}) {
    this.store = store;
    this.clock = options.clock || (() => Math.floor(Date.now() / 1000));
  }

  getBooleanDetails(flagKey, defaultValue, context) {
    return evaluate(this.store, flagKey, 'boolean', defaultValue, context);
  }
  getBooleanValue(flagKey, defaultValue, context) {
    return this.getBooleanDetails(flagKey, defaultValue, context).value;
  }

  getStringDetails(flagKey, defaultValue, context) {
    return evaluate(this.store, flagKey, 'string', defaultValue, context);
  }
  getStringValue(flagKey, defaultValue, context) {
    return this.getStringDetails(flagKey, defaultValue, context).value;
  }

  getNumberDetails(flagKey, defaultValue, context) {
    return evaluate(this.store, flagKey, 'number', defaultValue, context);
  }
  getNumberValue(flagKey, defaultValue, context) {
    return this.getNumberDetails(flagKey, defaultValue, context).value;
  }

  getObjectDetails(flagKey, defaultValue, context) {
    return evaluate(this.store, flagKey, 'object', defaultValue, context);
  }
  getObjectValue(flagKey, defaultValue, context) {
    return this.getObjectDetails(flagKey, defaultValue, context).value;
  }

  setFlag(actorId, key, flagType, defaultValueJson, enabled, rulesJson) {
    if (typeof actorId !== 'string' || actorId === '') {
      throw new FeatureFlagError('INVALID_ACTOR', 400, 'Actor ID must be a non-empty string');
    }
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(key)) {
      throw new FeatureFlagError('INVALID_KEY', 400, 'Key must be 1-128 characters matching [A-Za-z0-9_.-]');
    }
    if (!['boolean', 'string', 'number', 'object'].includes(flagType)) {
      throw new FeatureFlagError('INVALID_TYPE', 400, 'Invalid flag type');
    }
    if (typeof enabled !== 'boolean') {
      throw new FeatureFlagError('INVALID_ENABLED', 400, 'Enabled must be a boolean');
    }

    let parsedDefault;
    try {
      parsedDefault = parseJsonStrict(defaultValueJson);
    } catch (err) {
      throw new FeatureFlagError('INVALID_DEFAULT_VALUE', 400, 'Default value is not valid JSON: ' + err.message);
    }
    if (getKind(parsedDefault) !== flagType) {
      throw new FeatureFlagError('INVALID_DEFAULT_VALUE', 400, `Default value type mismatch: expected ${flagType}, got ${getKind(parsedDefault)}`);
    }

    let parsedRules;
    try {
      parsedRules = parseRules(rulesJson);
    } catch (err) {
      throw new FeatureFlagError('INVALID_RULES', 400, 'Rules are not valid: ' + err.message);
    }
    for (const rule of parsedRules) {
      if (getKind(rule.value) !== flagType) {
        throw new FeatureFlagError('INVALID_RULES', 400, `Rule value type mismatch: expected ${flagType}, got ${getKind(rule.value)}`);
      }
    }

    const now = this.clock();
    const record = {
      key,
      type: flagType,
      default_value_json: defaultValueJson,
      enabled,
      rules_json: rulesJson,
      updated_at: now,
      updated_by: actorId
    };

    try {
      return this.store.saveFlagAudited(record, actorId, now);
    } catch (err) {
      if (err instanceof FeatureFlagError) {
        throw err;
      }
      throw new FeatureFlagError('STORE_ERROR', 500, 'Store error: ' + err.message);
    }
  }
}

FeatureFlagClient.stableBucket = stableBucket;

module.exports = {
  FeatureFlagClient,
  InMemoryFlagStore,
  SqlFlagStore,
  FeatureFlagError,
  stableBucket,
  SCHEMA_STATEMENTS
};