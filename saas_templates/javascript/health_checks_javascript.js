class HealthCheckError extends Error {
  constructor(code, httpStatus, message) {
    super(message);
    this.name = 'HealthCheckError';
    this.code = code;
    this.http_status = httpStatus;
  }
}

class InMemoryCheckStore {
  constructor() {
    this.checks = new Map();
  }

  addCheck(check) {
    if (this.checks.has(check.component_id)) return false;
    this.checks.set(check.component_id, check);
    return true;
  }

  listChecks() {
    return Array.from(this.checks.values());
  }
}

class HealthChecker {
  constructor(store, options = {}) {
    if (!store) throw new HealthCheckError('INVALID_OPTION', 400, 'invalid option: store');
    this.store = store;
    this.clock = options.clock || (() => Date.now());
    if (typeof this.clock !== 'function') {
      throw new HealthCheckError('INVALID_OPTION', 400, 'invalid option: clock');
    }
    const metaFields = ['version', 'releaseId', 'serviceId', 'description'];
    for (const field of metaFields) {
      const value = options[field];
      if (value !== undefined && value !== null && value !== '') {
        if (typeof value !== 'string' || !this._validMetadata(value)) {
          throw new HealthCheckError('INVALID_OPTION', 400, `invalid option: ${field}`);
        }
        this[field] = value;
      }
    }
  }

  _validIdentifier(str) {
    if (typeof str !== 'string' || str.length < 1 || str.length > 64) return false;
    for (const ch of str) {
      const code = ch.charCodeAt(0);
      if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
            (code >= 48 && code <= 57) || code === 46 || code === 95 || code === 45)) {
        return false;
      }
    }
    return true;
  }

  _validMetadata(str) {
    if (typeof str !== 'string' || str.length < 1 || str.length > 128) return false;
    for (const ch of str) {
      const code = ch.charCodeAt(0);
      if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
            (code >= 48 && code <= 57) || code === 32 || code === 46 ||
            code === 95 || code === 44 || code === 40 || code === 41 || code === 45)) {
        return false;
      }
    }
    return true;
  }

  registerCheck(component_id, component_type, check_fn, critical, timeout_ms) {
    if (!this._validIdentifier(component_id)) {
      throw new HealthCheckError('INVALID_COMPONENT_ID', 400,
        'component_id must be 1-64 characters from A-Z a-z 0-9 . _ -');
    }
    if (!this._validIdentifier(component_type)) {
      throw new HealthCheckError('INVALID_COMPONENT_TYPE', 400,
        'component_type must be 1-64 characters from A-Z a-z 0-9 . _ -');
    }
    if (typeof check_fn !== 'function') {
      throw new HealthCheckError('INVALID_CHECK_FN', 400, 'check_fn must be a function');
    }
    if (typeof critical !== 'boolean') {
      throw new HealthCheckError('INVALID_CRITICAL', 400, 'critical must be a boolean');
    }
    if (!Number.isInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 60000) {
      throw new HealthCheckError('INVALID_TIMEOUT', 400, 'timeout_ms must be an integer from 1 to 60000');
    }
    const check = { component_id, component_type, check_fn, critical, timeout_ms };
    if (!this.store.addCheck(check)) {
      throw new HealthCheckError('DUPLICATE_COMPONENT', 409, 'component_id is already registered');
    }
  }

  liveness() {
    const bodyObj = { status: 'pass' };
    if (this.version !== undefined) bodyObj.version = this.version;
    if (this.releaseId !== undefined) bodyObj.releaseId = this.releaseId;
    if (this.serviceId !== undefined) bodyObj.serviceId = this.serviceId;
    if (this.description !== undefined) bodyObj.description = this.description;
    return { http_status: 200, content_type: 'application/health+json', body: JSON.stringify(bodyObj) };
  }

  async readiness() {
    const checks = this.store.listChecks();
    checks.sort((a, b) => {
      const keyA = a.component_id + ':responseTime';
      const keyB = b.component_id + ':responseTime';
      if (keyA < keyB) return -1;
      if (keyA > keyB) return 1;
      return 0;
    });

    const start = performance.now();
    const workers = checks.map(check => {
      const t0 = this.clock();
      const r0 = performance.now();
      const promise = Promise.resolve().then(() => check.check_fn()).then(
        result => {
          const r1 = performance.now();
          const t1 = this.clock();
          return { kind: result === true ? 'PASS' : 'REPORTED', t0, t1, real_ms: r1 - r0 };
        },
        () => {
          const r1 = performance.now();
          const t1 = this.clock();
          return { kind: 'ERRORED', t0, t1, real_ms: r1 - r0 };
        }
      );
      return { promise, check, deadline: start + check.timeout_ms };
    });

    const results = [];
    for (const worker of workers) {
      const { promise, check, deadline } = worker;
      const now = performance.now();
      let remaining = deadline - now;
      let result;

      if (remaining <= 0) {
        result = { kind: 'TIMED_OUT', timeout: true };
      } else {
        let timeoutId;
        const timeoutPromise = new Promise(resolve => { timeoutId = setTimeout(() => resolve({ timeout: true }), remaining); });
        try {
          const raceResult = await Promise.race([promise, timeoutPromise]);
          if (raceResult.timeout) {
            result = { kind: 'TIMED_OUT', timeout: true };
          } else if (raceResult.real_ms > check.timeout_ms) {
            result = { kind: 'TIMED_OUT', timeout: true, t1: raceResult.t1 };
          } else {
            result = { kind: raceResult.kind, t0: raceResult.t0, t1: raceResult.t1 };
          }
        } finally {
          clearTimeout(timeoutId);
        }
      }

      let status, observedValue, time, output;
      if (result.kind === 'TIMED_OUT') {
        status = 'fail';
        observedValue = check.timeout_ms;
        time = this.iso(result.t1 !== undefined ? result.t1 : this.clock());
        output = 'check timed out';
      } else if (result.kind === 'PASS') {
        status = 'pass';
        observedValue = Math.max(0, result.t1 - result.t0);
        time = this.iso(result.t1);
        output = undefined;
      } else {
        status = 'fail';
        observedValue = Math.max(0, result.t1 - result.t0);
        time = this.iso(result.t1);
        output = result.kind === 'ERRORED' ? 'check raised an error' : 'check reported failure';
      }

      const entry = {
        componentId: check.component_id,
        componentType: check.component_type,
        observedValue,
        observedUnit: 'ms',
        status,
        time
      };
      if (output !== undefined) entry.output = output;

      results.push({ key: `${check.component_id}:responseTime`, entry });
    }

    let criticalFailed = false, nonCriticalFailed = false;
    for (const { entry } of results) {
      if (entry.status === 'fail') {
        const check = checks.find(c => c.component_id === entry.componentId);
        if (check && check.critical) criticalFailed = true;
        else nonCriticalFailed = true;
      }
    }
    const overallStatus = criticalFailed ? 'fail' : nonCriticalFailed ? 'warn' : 'pass';
    const http_status = overallStatus === 'fail' ? 503 : 200;

    const bodyObj = { status: overallStatus };
    if (this.version !== undefined) bodyObj.version = this.version;
    if (this.releaseId !== undefined) bodyObj.releaseId = this.releaseId;
    if (this.serviceId !== undefined) bodyObj.serviceId = this.serviceId;
    if (this.description !== undefined) bodyObj.description = this.description;

    const checksObj = {};
    for (const { key, entry } of results) checksObj[key] = [entry];
    bodyObj.checks = checksObj;

    return { http_status, content_type: 'application/health+json', body: JSON.stringify(bodyObj) };
  }

  iso(ms) {
    const sec = Math.floor(ms / 1000);
    return new Date(sec * 1000).toISOString().slice(0, 19) + 'Z';
  }
}

module.exports = { HealthCheckError, InMemoryCheckStore, HealthChecker };