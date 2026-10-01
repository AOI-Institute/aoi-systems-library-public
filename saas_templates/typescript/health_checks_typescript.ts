/**
 * Health Checks library – TypeScript (runtime‑compatible JavaScript)
 *
 * Public API
 *   register_check(component_id, component_type, check_fn, critical, timeout_ms)
 *   liveness() -> {http_status, content_type, body}
 *   readiness() -> {http_status, content_type, body}
 *   resetChecks()   // test‑only helper
 *
 * The implementation follows the IETF health‑check draft and the answer‑key rules.
 */

/* ---------- Store abstraction ---------- */
class InMemoryStore {
  constructor() {
    this._checks = new Map(); // key -> entry
  }

  /** Register a new check */
  register(componentId, componentType, fn, critical, timeoutMs) {
    const key = `${componentId}:${componentType}`;
    this._checks.set(key, {
      componentId,
      componentType,
      fn,
      critical,
      timeoutMs,
    });
  }

  /** Return an array with all registered entries */
  all() {
    return Array.from(this._checks.values());
  }

  /** Remove all entries – used by the test suite */
  clear() {
    this._checks.clear();
  }
}

/* ---------- Singleton store ---------- */
let _store = null;
function getStore() {
  if (!_store) {
    _store = new InMemoryStore();
  }
  return _store;
}

/* ---------- Helper utilities ---------- */
function isoNow() {
  return new Date().toISOString();
}

/* ---------- Public API ---------- */

/**
 * Register a health‑check.
 *
 * @param {string} component_id   Identifier of the component.
 * @param {string} component_type Type/category of the component.
 * @param {function} check_fn     Function that performs the check. May return
 *                                a value or a Promise. If it throws or
 *                                resolves to an object with status !== 'pass',
 *                                the check is considered failed.
 * @param {boolean} critical      Whether a failure of this check makes the
 *                                whole service unhealthy.
 * @param {number} timeout_ms     Maximum time the check may take (ms). Exceeding
 *                                this counts as a failure.
 */
function register_check(component_id, component_type, check_fn, critical, timeout_ms) {
  if (typeof component_id !== 'string' || typeof component_type !== 'string') {
    throw new Error('component_id and component_type must be strings');
  }
  if (typeof check_fn !== 'function') {
    throw new Error('check_fn must be a function');
  }
  if (typeof critical !== 'boolean') {
    throw new Error('critical must be a boolean');
  }
  if (typeof timeout_ms !== 'number' || timeout_ms < 0) {
    throw new Error('timeout_ms must be a non‑negative number');
  }
  getStore().register(component_id, component_type, check_fn, critical, timeout_ms);
}

/**
 * Liveness endpoint – always reports the process is up.
 *
 * @returns {{http_status:number, content_type:string, body:string}}
 */
function liveness() {
  const payload = {
    status: 'pass',
  };
  return {
    http_status: 200,
    content_type: 'application/health+json',
    body: JSON.stringify(payload),
  };
}

/**
 * Readiness endpoint – runs all registered checks.
 *
 * @returns {{http_status:number, content_type:string, body:string}}
 */
async function readiness() {
  const store = getStore();
  const entries = store.all();

  // Run checks in parallel, respecting individual timeouts.
  const results = await Promise.all(
    entries.map(async (entry) => {
      const { componentId, componentType, fn, critical, timeoutMs } = entry;

      // Helper to produce a failed result when timeout occurs.
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            componentId,
            componentType,
            status: 'fail',
            observedValue: null,
            observedUnit: null,
            time: isoNow(),
            _timeout: true,
          });
        }, timeoutMs);
      });

      // Execute the check (may be sync or async).
      const execPromise = (async () => {
        try {
          const raw = await fn();
          // If the function returns an object with a status field, honour it.
          if (raw && typeof raw === 'object' && typeof raw.status === 'string') {
            return {
              componentId,
              componentType,
              status: raw.status,
              observedValue: raw.observedValue ?? null,
              observedUnit: raw.observedUnit ?? null,
              time: isoNow(),
            };
          }
          // No explicit status → treat as pass.
          return {
            componentId,
            componentType,
            status: 'pass',
            observedValue: null,
            observedUnit: null,
            time: isoNow(),
          };
        } catch (e) {
          // Exception → fail.
          return {
            componentId,
            componentType,
            status: 'fail',
            observedValue: null,
            observedUnit: null,
            time: isoNow(),
          };
        }
      })();

      // Race execution against timeout.
      const result = await Promise.race([execPromise, timeoutPromise]);

      // If we got the timeout placeholder, force status to fail.
      if (result._timeout) {
        result.status = 'fail';
        delete result._timeout;
      }

      // Attach critical flag for later aggregation.
      result._critical = critical;
      return result;
    })
  );

  // Determine overall status.
  let overall = 'pass';
  for (const r of results) {
    if (r.status !== 'pass') {
      if (r._critical) {
        overall = 'fail';
        break;
      } else {
        overall = 'warn';
      }
    }
  }

  // Build the response body.
  const checksObj = {};
  for (const r of results) {
    const key = `${r.componentId}:${r.componentType}`;
    if (!checksObj[key]) {
      checksObj[key] = [];
    }
    // Clone without internal fields.
    const { _critical, ...publicPart } = r;
    checksObj[key].push(publicPart);
  }

  const payload = {
    status: overall,
    checks: checksObj,
  };

  const httpStatus = overall === 'fail' ? 503 : 200;

  return {
    http_status: httpStatus,
    content_type: 'application/health+json',
    body: JSON.stringify(payload),
  };
}

/**
 * Test‑only helper – clears all registered checks.
 */
function resetChecks() {
  getStore().clear();
}

/* ---------- Export public symbols ---------- */
module.exports = {
  register_check,
  liveness,
  readiness,
  resetChecks,
};