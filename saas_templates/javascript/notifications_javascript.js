'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

/* ============================================================================
 * DATABASE SCHEMA (executable DDL)
 * ========================================================================== */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notification_templates (
  key             TEXT PRIMARY KEY,
  subject         TEXT,
  body_text       TEXT,
  body_html       TEXT,
  channels_default TEXT,
  variables       TEXT
);

CREATE TABLE IF NOT EXISTS notification_logs (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  template_key  TEXT NOT NULL,
  channel       TEXT NOT NULL,
  vars_used     TEXT,
  sent_at       TEXT,
  opened_at     TEXT,
  clicked_at    TEXT,
  bounced       INTEGER DEFAULT 0,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id             INTEGER PRIMARY KEY,
  do_not_disturb      INTEGER DEFAULT 0,
  quiet_hours_start   TEXT,
  quiet_hours_end     TEXT,
  channels_enabled    TEXT
);

CREATE TABLE IF NOT EXISTS user_unsubscribes (
  user_id   INTEGER PRIMARY KEY,
  channel   TEXT NOT NULL,
  created_at TEXT
);
`;

/* ============================================================================
 * DEFAULT TEMPLATES
 * ========================================================================== */
const DEFAULT_TEMPLATES = {
  welcome_email: {
    key: 'welcome_email',
    subject: 'Welcome to {app_name}!',
    body_text: "Welcome to {app_name}! Here's your first step.",
    body_html: '<p>Welcome to <strong>{app_name}</strong>! Here\'s your first step.</p>',
    channels_default: 'email',
    variables: 'app_name',
  },
  trial_starting: {
    key: 'trial_starting',
    subject: 'Your free trial is starting',
    body_text: 'Your free trial is starting. You have {trial_days} days.',
    body_html: '<p>Your free trial is starting. You have <strong>{trial_days}</strong> days.</p>',
    channels_default: 'email',
    variables: 'trial_days',
  },
  trial_ending_soon: {
    key: 'trial_ending_soon',
    subject: 'Your trial ends in {days_left} days',
    body_text: 'Your trial ends in {days_left} days. Add payment method to continue.',
    body_html: '<p>Your trial ends in <strong>{days_left}</strong> days. Add payment method to continue.</p>',
    channels_default: 'email',
    variables: 'days_left',
  },
  subscription_changed: {
    key: 'subscription_changed',
    subject: 'Your plan changed',
    body_text: 'Your plan changed from {old_tier} to {new_tier}. Effective {effective_date}.',
    body_html: '<p>Your plan changed from <strong>{old_tier}</strong> to <strong>{new_tier}</strong>. Effective {effective_date}.</p>',
    channels_default: 'email',
    variables: 'old_tier,new_tier,effective_date',
  },
  payment_failed: {
    key: 'payment_failed',
    subject: 'Payment failed for invoice {invoice_id}',
    body_text: 'Payment failed for invoice {invoice_id}. {retry_date} retry, or update payment method.',
    body_html: '<p>Payment failed for invoice <strong>{invoice_id}</strong>. {retry_date} retry, or update payment method.</p>',
    channels_default: 'email',
    variables: 'invoice_id,retry_date',
  },
  deployment_live: {
    key: 'deployment_live',
    subject: 'Your deployment {deployment_name} is live',
    body_text: 'Your deployment {deployment_name} is now live at {url}.',
    body_html: '<p>Your deployment <strong>{deployment_name}</strong> is now live at <a href="{url}">{url}</a>.</p>',
    channels_default: 'email',
    variables: 'deployment_name,url',
  },
  user_invited: {
    key: 'user_invited',
    subject: 'You\'ve been invited to {workspace}',
    body_text: 'You\'ve been invited to {workspace}. Click here to join.',
    body_html: '<p>You\'ve been invited to <strong>{workspace}</strong>. <a href="{join_url}">Click here to join</a>.</p>',
    channels_default: 'email',
    variables: 'workspace,join_url',
  },
  invoice_ready: {
    key: 'invoice_ready',
    subject: 'Your invoice for {month} is ready',
    body_text: 'Your invoice for {month} is ready. Download here.',
    body_html: '<p>Your invoice for <strong>{month}</strong> is ready. <a href="{download_url}">Download here</a>.</p>',
    channels_default: 'email',
    variables: 'month,download_url',
  },
  admin_alert: {
    key: 'admin_alert',
    subject: 'Admin alert',
    body_text: '{actor} performed {action} on {resource}.',
    body_html: '<p>{actor} performed <strong>{action}</strong> on {resource}.</p>',
    channels_default: 'in_app',
    variables: 'actor,action,resource',
  },
};

/* ============================================================================
 * UTILITIES
 * ========================================================================== */
function generateId(prefix) {
  const rand = crypto.randomBytes(16).toString('hex');
  return prefix ? `${prefix}_${rand}` : rand;
}

function nowIso() {
  return new Date().toISOString();
}

function parseTimeToMinutes(t) {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function inQuietHours(start, end, date) {
  const s = parseTimeToMinutes(start);
  const e = parseTimeToMinutes(end);
  if (s === null || e === null) return false;
  const d = date || new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  if (s === e) return false;
  if (s < e) return cur >= s && cur < e;
  // wraps midnight
  return cur >= s || cur < e;
}

function renderTemplate(text, vars) {
  if (text == null) return '';
  return String(text).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return String(vars[name]);
    }
    return match;
  });
}

function buildUnsubscribeUrl(baseUrl, userId, channel) {
  const token = crypto.createHash('sha256')
    .update(`${userId}:${channel}:unsubscribe`)
    .digest('hex');
  return `${baseUrl}/unsubscribe?token=${token}`;
}

function buildTrackUrl(baseUrl, messageId, action) {
  return `${baseUrl}/track/${messageId}/${action}`;
}

/* ============================================================================
 * NOTIFICATION SERVICE
 * ========================================================================== */
class NotificationService extends EventEmitter {
  constructor(options) {
    super();
    const opts = options || {};
    this.baseUrl = opts.baseUrl || 'http://localhost:3000';
    this.maxRetries = opts.maxRetries != null ? opts.maxRetries : 3;
    this.retryBaseDelayMs = opts.retryBaseDelayMs != null ? opts.retryBaseDelayMs : 100;
    this.nowFn = opts.nowFn || (() => new Date());
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

    // In-memory stores
    this.templates = new Map();
    this.logs = new Map();
    this.preferences = new Map();
    this.unsubscribes = new Set();
    this.queue = [];

    // Channel senders (overridable for testing / real providers)
    this.emailSender = opts.emailSender || this._defaultEmailSender.bind(this);
    this.smsSender = opts.smsSender || this._defaultSmsSender.bind(this);
    this.inAppSender = opts.inAppSender || this._defaultInAppSender.bind(this);

    this._seedTemplates();
  }

  _seedTemplates() {
    for (const t of Object.values(DEFAULT_TEMPLATES)) {
      this.templates.set(t.key, { ...t });
    }
  }

  /* ---- Template management ---- */
  getTemplate(key) {
    return this.templates.get(key) || null;
  }

  upsertTemplate(template) {
    if (!template || !template.key) {
      throw new Error('template.key is required');
    }
    this.templates.set(template.key, { ...template });
    return this.templates.get(template.key);
  }

  /* ---- Preference management ---- */
  getPreferences(userId) {
    const p = this.preferences.get(userId);
    if (!p) {
      return {
        user_id: userId,
        do_not_disturb: false,
        quiet_hours_start: '22:00',
        quiet_hours_end: '08:00',
        channels_enabled: { email: true, sms: false, in_app: true },
      };
    }
    return {
      user_id: userId,
      do_not_disturb: !!p.do_not_disturb,
      quiet_hours_start: p.quiet_hours_start || '22:00',
      quiet_hours_end: p.quiet_hours_end || '08:00',
      channels_enabled: p.channels_enabled || { email: true, sms: false, in_app: true },
    };
  }

  updatePreferences(userId, updates) {
    const existing = this.preferences.get(userId) || {
      user_id: userId,
      do_not_disturb: false,
      quiet_hours_start: '22:00',
      quiet_hours_end: '08:00',
      channels_enabled: { email: true, sms: false, in_app: true },
    };
    const merged = { ...existing };
    if (updates.do_not_disturb !== undefined) merged.do_not_disturb = !!updates.do_not_disturb;
    if (updates.quiet_hours_start !== undefined) merged.quiet_hours_start = updates.quiet_hours_start;
    if (updates.quiet_hours_end !== undefined) merged.quiet_hours_end = updates.quiet_hours_end;
    if (updates.channels_enabled !== undefined) {
      merged.channels_enabled = { ...merged.channels_enabled, ...updates.channels_enabled };
    }
    this.preferences.set(userId, merged);
    return { success: true };
  }

  /* ---- Unsubscribe ---- */
  isUnsubscribed(userId, channel) {
    return this.unsubscribes.has(`${userId}:${channel}`);
  }

  unsubscribe(userId, channel) {
    this.unsubscribes.add(`${userId}:${channel}`);
    return { success: true };
  }

  /* ---- Channel resolution ---- */
  _resolveChannel(requestedChannel, template, prefs) {
    if (requestedChannel) return requestedChannel;
    const channels = (template && template.channels_default)
      ? String(template.channels_default).split(',').map((s) => s.trim()).filter(Boolean)
      : ['email'];
    const enabled = prefs.channels_enabled || {};
    for (const ch of channels) {
      if (enabled[ch] === true) return ch;
    }
    // fallback: first enabled channel, else first default
    for (const ch of channels) {
      if (enabled[ch] !== false) return ch;
    }
    return channels[0] || 'email';
  }

  /* ---- Core send ---- */
  async send(payload) {
    if (!payload || payload.user_id == null) {
      throw new Error('user_id is required');
    }
    if (!payload.template_key) {
      throw new Error('template_key is required');
    }
    const template = this.getTemplate(payload.template_key);
    if (!template) {
      throw new Error(`Unknown template: ${payload.template_key}`);
    }

    const prefs = this.getPreferences(payload.user_id);
    const channel = this._resolveChannel(payload.channel, template, prefs);
    const vars = payload.vars || {};
    const messageId = generateId('msg');

    const log = {
      id: messageId,
      user_id: payload.user_id,
      template_key: payload.template_key,
      channel,
      vars_used: JSON.stringify(vars),
      sent_at: null,
      opened_at: null,
      clicked_at: null,
      bounced: false,
      error: null,
      status: 'pending',
    };
    this.logs.set(messageId, log);

    // Do-not-disturb: skip
    if (prefs.do_not_disturb) {
      log.status = 'skipped';
      log.error = 'do_not_disturb';
      return { success: true, message_id: messageId, status: 'skipped' };
    }

    // Unsubscribe check (email/sms)
    if ((channel === 'email' || channel === 'sms') && this.isUnsubscribed(payload.user_id, channel)) {
      log.status = 'skipped';
      log.error = 'unsubscribed';
      return { success: true, message_id: messageId, status: 'skipped' };
    }

    // Channel disabled check
    const enabled = prefs.channels_enabled || {};
    if (enabled[channel] === false) {
      log.status = 'skipped';
      log.error = 'channel_disabled';
      return { success: true, message_id: messageId, status: 'skipped' };
    }

    // Scheduled delivery
    if (payload.scheduled_at) {
      const scheduled = new Date(payload.scheduled_at);
      const now = this.nowFn();
      if (scheduled > now) {
        log.status = 'queued';
        this.queue.push({ messageId, payload, channel, template, prefs, vars, scheduledAt: scheduled });
        this.queue.sort((a, b) => a.scheduledAt - b.scheduledAt);
        return { success: true, message_id: messageId, status: 'queued' };
      }
    }

    // Quiet hours: queue for quiet_hours_end
    const now = this.nowFn();
    if (inQuietHours(prefs.quiet_hours_start, prefs.quiet_hours_end, now)) {
      log.status = 'queued';
      const endMin = parseTimeToMinutes(prefs.quiet_hours_end);
      const release = new Date(now);
      release.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
      if (release <= now) release.setDate(release.getDate() + 1);
      this.queue.push({ messageId, payload, channel, template, prefs, vars, scheduledAt: release });
      this.queue.sort((a, b) => a.scheduledAt - b.scheduledAt);
      return { success: true, message_id: messageId, status: 'queued' };
    }

    // Deliver
    const result = await this._deliverWithRetry(messageId, channel, template, vars, payload.user_id);
    return result;
  }

  async _deliverWithRetry(messageId, channel, template, vars, userId) {
    const log = this.logs.get(messageId);
    let attempt = 0;
    let lastError = null;
    while (attempt <= this.maxRetries) {
      try {
        await this._deliverOnce(messageId, channel, template, vars, userId);
        log.status = 'sent';
        log.sent_at = nowIso();
        log.error = null;
        log.bounced = false;
        this.emit('sent', log);
        return { success: true, message_id: messageId, status: 'sent' };
      } catch (err) {
        lastError = err;
        attempt += 1;
        if (attempt > this.maxRetries) break;
        const delay = this.retryBaseDelayMs * Math.pow(2, attempt - 1);
        await this.sleep(delay);
      }
    }
    log.status = 'failed';
    log.error = lastError ? lastError.message : 'unknown';
    log.bounced = true;
    this.emit('failed', log);
    return { success: false, message_id: messageId, status: 'failed', error: log.error };
  }

  async _deliverOnce(messageId, channel, template, vars, userId) {
    const subject = renderTemplate(template.subject, vars);
    const bodyText = renderTemplate(template.body_text, vars);
    const bodyHtml = renderTemplate(template.body_html, vars);

    if (channel === 'email') {
      const unsubscribeUrl = buildUnsubscribeUrl(this.baseUrl, userId, 'email');
      const trackOpenUrl = buildTrackUrl(this.baseUrl, messageId, 'open');
      const trackClickUrl = buildTrackUrl(this.baseUrl, messageId, 'click');
      const html = `${bodyHtml}<hr><p><a href="${unsubscribeUrl}">Unsubscribe</a></p>`;
      const openPixel = `<img src="${trackOpenUrl}" width="1" height="1" alt="">`;
      await this.emailSender({
        to: userId,
        subject,
        text: bodyText,
        html: `${openPixel}${html}`,
        unsubscribeUrl,
        trackOpenUrl,
        trackClickUrl,
      });
    } else if (channel === 'sms') {
      await this.smsSender({ to: userId, body: bodyText });
    } else if (channel === 'in_app') {
      await this.inAppSender({ userId, subject, body: bodyText, template_key: template.key, vars });
    } else {
      throw new Error(`Unsupported channel: ${channel}`);
    }
  }

  /* ---- Default senders (no-op success; real providers plug in here) ---- */
  async _defaultEmailSender() { /* provider no-op */ }
  async _defaultSmsSender() { /* provider no-op */ }
  async _defaultInAppSender() { /* stored in logs */ }

  /* ---- Batch send ---- */
  async sendBatch(items) {
    if (!Array.isArray(items)) throw new Error('batch must be an array');
    let sent = 0;
    let failed = 0;
    const messageIds = [];
    for (const item of items) {
      try {
        const res = await this.send(item);
        messageIds.push(res.message_id);
        if (res.status === 'sent' || res.status === 'queued' || res.status === 'skipped') {
          sent += 1;
        } else {
          failed += 1;
        }
      } catch (err) {
        failed += 1;
      }
    }
    return { success: true, sent, failed, message_ids: messageIds };
  }

  /* ---- Tracking ---- */
  track(messageId) {
    const log = this.logs.get(messageId);
    if (!log) {
      return { error: 'not_found', message: `Message ${messageId} not found` };
    }
    let status = 'sent';
    if (log.bounced) status = 'bounced';
    else if (log.clicked_at) status = 'clicked';
    else if (log.opened_at) status = 'opened';
    else if (log.status === 'sent') status = 'sent';
    else if (log.status === 'failed') status = 'failed';
    else if (log.status === 'skipped') status = 'skipped';
    else if (log.status === 'queued') status = 'queued';
    return {
      message_id: log.id,
      user_id: log.user_id,
      template_key: log.template_key,
      channel: log.channel,
      status,
      sent_at: log.sent_at,
      opened_at: log.opened_at,
      clicked_at: log.clicked_at,
    };
  }

  markOpened(messageId) {
    const log = this.logs.get(messageId);
    if (!log) return { success: false, error: 'not_found' };
    if (!log.opened_at) log.opened_at = nowIso();
    return { success: true, message_id: messageId, status: 'opened' };
  }

  markClicked(messageId) {
    const log = this.logs.get(messageId);
    if (!log) return { success: false, error: 'not_found' };
    if (!log.opened_at) log.opened_at = nowIso();
    if (!log.clicked_at) log.clicked_at = nowIso();
    return { success: true, message_id: messageId, status: 'clicked' };
  }

  /* ---- In-app fetch ---- */
  getInAppNotifications(userId) {
    const out = [];
    for (const log of this.logs.values()) {
      if (log.user_id === userId && log.channel === 'in_app' && log.status === 'sent') {
        out.push({
          message_id: log.id,
          template_key: log.template_key,
          vars: JSON.parse(log.vars_used || '{}'),
          sent_at: log.sent_at,
          read: !!log.opened_at,
        });
      }
    }
    return out;
  }

  /* ---- Process queued (scheduled / quiet-hours) messages ---- */
  async processQueue() {
    const now = this.nowFn();
    const due = [];
    this.queue = this.queue.filter((item) => {
      if (item.scheduledAt <= now) {
        due.push(item);
        return false;
      }
      return true;
    });
    const results = [];
    for (const item of due) {
      const log = this.logs.get(item.messageId);
      if (!log) continue;
      const prefs = this.getPreferences(item.payload.user_id);
      if (prefs.do_not_disturb) {
        log.status = 'skipped';
        log.error = 'do_not_disturb';
        results.push({ success: true, message_id: item.messageId, status: 'skipped' });
        continue;
      }
      const res = await this._deliverWithRetry(item.messageId, item.channel, item.template, item.vars, item.payload.user_id);
      results.push(res);
    }
    return results;
  }

  /* ---- DDL export ---- */
  getSchemaSql() {
    return SCHEMA_SQL;
  }
}

/* ============================================================================
 * HTTP ROUTER (Express-compatible)
 * ========================================================================== */
function createRouter(service) {
  const routes = [];
  function add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }) + '$'
    );
    routes.push({ method, regex, keys, handler });
  }

  add('POST', '/notifications/send', async (req) => {
    try {
      const res = await service.send(req.body || {});
      return { status: 200, body: res };
    } catch (err) {
      return { status: 400, body: { success: false, error: err.message } };
    }
  });

  add('POST', '/notifications/send-batch', async (req) => {
    try {
      const res = await service.sendBatch(req.body || []);
      return { status: 200, body: res };
    } catch (err) {
      return { status: 400, body: { success: false, error: err.message } };
    }
  });

  add('GET', '/notifications/track/:message_id', async (req) => {
    const res = service.track(req.params.message_id);
    if (res.error) return { status: 404, body: res };
    return { status: 200, body: res };
  });

  add('GET', '/notifications/in-app/:user_id', async (req) => {
    return { status: 200, body: { user_id: Number(req.params.user_id), notifications: service.getInAppNotifications(Number(req.params.user_id)) } };
  });

  add('GET', '/users/:user_id/notification-preferences', async (req) => {
    return { status: 200, body: service.getPreferences(Number(req.params.user_id)) };
  });

  add('PUT', '/users/:user_id/notification-preferences', async (req) => {
    service.updatePreferences(Number(req.params.user_id), req.body || {});
    return { status: 200, body: { success: true } };
  });

  add('GET', '/track/:message_id/open', async (req) => {
    const res = service.markOpened(req.params.message_id);
    return { status: res.success ? 200 : 404, body: res };
  });

  add('GET', '/track/:message_id/click', async (req) => {
    const res = service.markClicked(req.params.message_id);
    return { status: res.success ? 200 : 404, body: res };
  });

  add('GET', '/unsubscribe', async (req) => {
    // token encodes user:channel; for demo we accept query user_id/channel
    const userId = req.query && req.query.user_id;
    const channel = (req.query && req.query.channel) || 'email';
    if (userId == null) return { status: 400, body: { success: false, error: 'user_id required' } };
    service.unsubscribe(Number(userId), channel);
    return { status: 200, body: { success: true } };
  });

  return {
    routes,
    async handle(method, path, req) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.regex.exec(path);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
        const out = await r.handler({ params, query: req.query, body: req.body });
        return out;
      }
      return { status: 404, body: { success: false, error: 'not_found' } };
    },
  };
}

module.exports = {
  NotificationService,
  createRouter,
  DEFAULT_TEMPLATES,
  SCHEMA_SQL,
  renderTemplate,
  inQuietHours,
  generateId,
};