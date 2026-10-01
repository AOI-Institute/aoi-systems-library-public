import { Database } from 'sqlite3';
import { open, Database as SQLiteDatabase } from 'sqlite';
import nodemailer, { Transporter } from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';
import { Twilio, twiml } from 'twilio';
import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';

type NotificationChannel = 'email' | 'sms' | 'in_app';
type NotificationStatus = 'sent' | 'queued' | 'failed' | 'skipped' | 'bounced' | 'opened' | 'clicked';

interface NotificationTemplate {
  key: string;
  subject: string;
  body_text: string;
  body_html: string;
  channels_default: NotificationChannel[];
  variables: string[];
}

interface NotificationLog {
  id: string;
  user_id: number;
  template_key: string;
  channel: NotificationChannel;
  vars_used: string;
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  bounced: boolean;
  error: string | null;
  status: NotificationStatus;
}

interface UserPreferences {
  user_id: number;
  do_not_disturb: boolean;
  quiet_hours_start: string; // HH:mm
  quiet_hours_end: string;   // HH:mm
  channels_enabled: { [key in NotificationChannel]?: boolean };
}

interface SendParams {
  user_id: number;
  template_key: string;
  channel: NotificationChannel | null;
  vars: { [key: string]: any };
  scheduled_at: string | null; // ISO 8601
}

interface SendBatchParams extends SendParams {}

interface TrackParams {
  message_id: string;
  status: NotificationStatus;
}

export class NotificationService {
  private db: SQLiteDatabase;
  private emailTransport: Transporter;
  private smsClient: Twilio;
  private templates: Map<string, NotificationTemplate> = new Map();

  constructor(
    private dbPath: string = ':memory:',
    emailTransport?: Transporter,
    smsClient?: Twilio
  ) {
    this.emailTransport = emailTransport || nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: {
        user: 'ethereal_user',
        pass: 'ethereal_pass',
      },
    });
    this.smsClient = smsClient || new Twilio('ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', 'your_auth_token');
  }

  async init(): Promise<void> {
    this.db = await open({
      filename: this.dbPath,
      driver: Database,
    });
    await this.runDDL();
    await this.loadTemplates();
  }

  private async runDDL(): Promise<void> {
    const ddl = `
      CREATE TABLE IF NOT EXISTS notification_templates (
        key TEXT PRIMARY KEY,
        subject TEXT,
        body_text TEXT,
        body_html TEXT,
        channels_default TEXT,
        variables TEXT
      );
      CREATE TABLE IF NOT EXISTS notification_logs (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        template_key TEXT,
        channel TEXT,
        vars_used TEXT,
        sent_at TEXT,
        opened_at TEXT,
        clicked_at TEXT,
        bounced INTEGER,
        error TEXT,
        status TEXT
      );
      CREATE TABLE IF NOT EXISTS user_notification_preferences (
        user_id INTEGER PRIMARY KEY,
        do_not_disturb INTEGER,
        quiet_hours_start TEXT,
        quiet_hours_end TEXT,
        channels_enabled TEXT
      );
    `;
    await this.db.exec(ddl);
    await this.seedTemplates();
  }

  private async seedTemplates(): Promise<void> {
    const templates: NotificationTemplate[] = [
      {
        key: 'welcome_email',
        subject: 'Welcome to {app_name}!',
        body_text: 'Welcome to {app_name}! Here\'s your first step.',
        body_html: '<p>Welcome to {app_name}! Here\'s your first step.</p>',
        channels_default: ['email'],
        variables: ['app_name'],
      },
      {
        key: 'trial_starting',
        subject: 'Your free trial is starting',
        body_text: 'Your free trial is starting. You have {trial_days} days.',
        body_html: '<p>Your free trial is starting. You have {trial_days} days.</p>',
        channels_default: ['email'],
        variables: ['trial_days'],
      },
      {
        key: 'trial_ending_soon',
        subject: 'Your trial ends soon',
        body_text: 'Your trial ends in {days_left} days. Add payment method to continue.',
        body_html: '<p>Your trial ends in {days_left} days. Add payment method to continue.</p>',
        channels_default: ['email'],
        variables: ['days_left'],
      },
      {
        key: 'subscription_changed',
        subject: 'Your plan changed',
        body_text: 'Your plan changed from {old_tier} to {new_tier}. Effective {effective_date}.',
        body_html: '<p>Your plan changed from {old_tier} to {new_tier}. Effective {effective_date}.</p>',
        channels_default: ['email'],
        variables: ['old_tier', 'new_tier', 'effective_date'],
      },
      {
        key: 'payment_failed',
        subject: 'Payment failed',
        body_text: 'Payment failed for invoice {invoice_id}. {retry_date} retry, or update payment method.',
        body_html: '<p>Payment failed for invoice {invoice_id}. {retry_date} retry, or update payment method.</p>',
        channels_default: ['email'],
        variables: ['invoice_id', 'retry_date'],
      },
      {
        key: 'deployment_live',
        subject: 'Deployment live',
        body_text: 'Your deployment {deployment_name} is now live at {url}.',
        body_html: '<p>Your deployment {deployment_name} is now live at {url}.</p>',
        channels_default: ['email'],
        variables: ['deployment_name', 'url'],
      },
      {
        key: 'user_invited',
        subject: 'You\'ve been invited',
        body_text: 'You\'ve been invited to {workspace}. Click here to join.',
        body_html: '<p>You\'ve been invited to {workspace}. <a href="#">Click here to join</a>.</p>',
        channels_default: ['email'],
        variables: ['workspace'],
      },
      {
        key: 'invoice_ready',
        subject: 'Your invoice is ready',
        body_text: 'Your invoice for {month} is ready. Download here.',
        body_html: '<p>Your invoice for {month} is ready. <a href="#">Download here</a>.</p>',
        channels_default: ['email'],
        variables: ['month'],
      },
      {
        key: 'admin_alert',
        subject: 'Admin alert',
        body_text: '{actor} performed {action} on {resource}.',
        body_html: '<p>{actor} performed {action} on {resource}.</p>',
        channels_default: ['email'],
        variables: ['actor', 'action', 'resource'],
      },
    ];
    for (const tmpl of templates) {
      await this.db.run(
        `INSERT OR REPLACE INTO notification_templates
        (key, subject, body_text, body_html, channels_default, variables)
        VALUES (?, ?, ?, ?, ?, ?)`,
        tmpl.key,
        tmpl.subject,
        tmpl.body_text,
        tmpl.body_html,
        JSON.stringify(tmpl.channels_default),
        JSON.stringify(tmpl.variables)
      );
    }
  }

  private async loadTemplates(): Promise<void> {
    const rows = await this.db.all<NotificationTemplate[]>(`SELECT * FROM notification_templates`);
    for (const row of rows) {
      row.channels_default = JSON.parse(row.channels_default);
      row.variables = JSON.parse(row.variables);
      this.templates.set(row.key, row);
    }
  }

  private async getUserPreferences(user_id: number): Promise<UserPreferences> {
    const row = await this.db.get<UserPreferences>(`SELECT * FROM user_notification_preferences WHERE user_id = ?`, user_id);
    if (!row) {
      // default preferences
      const defaultPrefs: UserPreferences = {
        user_id,
        do_not_disturb: false,
        quiet_hours_start: '22:00',
        quiet_hours_end: '08:00',
        channels_enabled: { email: true, sms: true, in_app: true },
      };
      await this.db.run(
        `INSERT INTO user_notification_preferences
        (user_id, do_not_disturb, quiet_hours_start, quiet_hours_end, channels_enabled)
        VALUES (?, ?, ?, ?, ?)`,
        user_id,
        defaultPrefs.do_not_disturb ? 1 : 0,
        defaultPrefs.quiet_hours_start,
        defaultPrefs.quiet_hours_end,
        JSON.stringify(defaultPrefs.channels_enabled)
      );
      return defaultPrefs;
    }
    row.channels_enabled = JSON.parse(row.channels_enabled);
    row.do_not_disturb = !!row.do_not_disturb;
    return row;
  }

  async updateUserPreferences(user_id: number, prefs: Partial<UserPreferences>): Promise<{ success: boolean }> {
    const current = await this.getUserPreferences(user_id);
    const updated: UserPreferences = {
      ...current,
      ...prefs,
      channels_enabled: { ...current.channels_enabled, ...prefs.channels_enabled },
    };
    await this.db.run(
      `UPDATE user_notification_preferences SET
        do_not_disturb = ?,
        quiet_hours_start = ?,
        quiet_hours_end = ?,
        channels_enabled = ?
      WHERE user_id = ?`,
      updated.do_not_disturb ? 1 : 0,
      updated.quiet_hours_start,
      updated.quiet_hours_end,
      JSON.stringify(updated.channels_enabled),
      user_id
    );
    return { success: true };
  }

  private async shouldSendNow(prefs: UserPreferences): Promise<boolean> {
    if (prefs.do_not_disturb) return false;
    const now = new Date();
    const start = this.parseTime(prefs.quiet_hours_start);
    const end = this.parseTime(prefs.quiet_hours_end);
    if (start <= end) {
      if (now >= start && now <= end) return false;
    } else {
      // overnight
      if (now >= start || now <= end) return false;
    }
    return true;
  }

  private parseTime(timeStr: string): Date {
    const [h, m] = timeStr.split(':').map(Number);
    const now = new Date();
    now.setHours(h, m, 0, 0);
    return now;
  }

  private renderTemplate(template: NotificationTemplate, vars: { [key: string]: any }): { subject: string; body_text: string; body_html: string } {
    const replace = (text: string) => {
      return text.replace(/{(\w+)}/g, (_, key) => {
        return vars[key] !== undefined ? String(vars[key]) : `{${key}}`;
      });
    };
    return {
      subject: replace(template.subject),
      body_text: replace(template.body_text),
      body_html: replace(template.body_html),
    };
  }

  private async logMessage(log: Omit<NotificationLog, 'id'>): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO notification_logs
      (id, user_id, template_key, channel, vars_used, sent_at, opened_at, clicked_at, bounced, error, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      log.user_id,
      log.template_key,
      log.channel,
      JSON.stringify(log.vars_used),
      log.sent_at,
      log.opened_at,
      log.clicked_at,
      log.bounced ? 1 : 0,
      log.error,
      log.status
    );
    return id;
  }

  private async updateLogStatus(id: string, updates: Partial<NotificationLog>): Promise<void> {
    const fields = [];
    const values: any[] = [];
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.opened_at !== undefined) {
      fields.push('opened_at = ?');
      values.push(updates.opened_at);
    }
    if (updates.clicked_at !== undefined) {
      fields.push('clicked_at = ?');
      values.push(updates.clicked_at);
    }
    if (updates.bounced !== undefined) {
      fields.push('bounced = ?');
      values.push(updates.bounced ? 1 : 0);
    }
    if (updates.error !== undefined) {
      fields.push('error = ?');
      values.push(updates.error);
    }
    if (fields.length === 0) return;
    values.push(id);
    await this.db.run(`UPDATE notification_logs SET ${fields.join(', ')} WHERE id = ?`, ...values);
  }

  private async sendEmail(user_id: number, template: NotificationTemplate, vars: any, message_id: string): Promise<void> {
    const rendered = this.renderTemplate(template, vars);
    const mailOptions = {
      from: '"Example App" <no-reply@example.com>',
      to: `user${user_id}@example.com`,
      subject: rendered.subject,
      text: rendered.body_text,
      html: rendered.body_html + `<p><a href="https://example.com/unsubscribe?user_id=${user_id}&channel=email">Unsubscribe</a></p>`,
    };
    await this.emailTransport.sendMail(mailOptions);
  }

  private async sendSMS(user_id: number, template: NotificationTemplate, vars: any, message_id: string): Promise<void> {
    const rendered = this.renderTemplate(template, vars);
    await this.smsClient.messages.create({
      body: rendered.body_text,
      from: '+15555555555',
      to: `+1555${user_id}`,
    });
  }

  private async sendInApp(user_id: number, template: NotificationTemplate, vars: any, message_id: string): Promise<void> {
    // In-app notifications are stored in logs; nothing else to do
  }

  private async attemptSend(channel: NotificationChannel, user_id: number, template: NotificationTemplate, vars: any, message_id: string, attempt: number = 1): Promise<void> {
    try {
      if (channel === 'email') {
        await this.sendEmail(user_id, template, vars, message_id);
      } else if (channel === 'sms') {
        await this.sendSMS(user_id, template, vars, message_id);
      } else if (channel === 'in_app') {
        await this.sendInApp(user_id, template, vars, message_id);
      }
      await this.updateLogStatus(message_id, { status: 'sent', sent_at: new Date().toISOString() });
    } catch (err: any) {
      if (attempt < 3) {
        const backoff = Math.pow(2, attempt) * 1000;
        await new Promise(res => setTimeout(res, backoff));
        await this.attemptSend(channel, user_id, template, vars, message_id, attempt + 1);
      } else {
        await this.updateLogStatus(message_id, { status: 'failed', error: err.message });
      }
    }
  }

  async sendSingle(params: SendParams): Promise<{ success: boolean; message_id: string; status: NotificationStatus }> {
    const { user_id, template_key, channel, vars, scheduled_at } = params;
    const template = this.templates.get(template_key);
    if (!template) throw new Error(`Template ${template_key} not found`);
    const prefs = await this.getUserPreferences(user_id);
    let chosenChannel: NotificationChannel;
    if (channel) {
      chosenChannel = channel;
    } else {
      if (prefs.channels_enabled.email) chosenChannel = 'email';
      else if (prefs.channels_enabled.sms) chosenChannel = 'sms';
      else chosenChannel = 'in_app';
    }
    const message_id = await this.logMessage({
      user_id,
      template_key,
      channel: chosenChannel,
      vars_used: vars,
      sent_at: null,
      opened_at: null,
      clicked_at: null,
      bounced: false,
      error: null,
      status: 'queued',
    });
    const shouldSend = await this.shouldSendNow(prefs);
    if (!shouldSend) {
      await this.updateLogStatus(message_id, { status: 'skipped' });
      return { success: true, message_id, status: 'skipped' };
    }
    if (scheduled_at) {
      const delay = new Date(scheduled_at).getTime() - Date.now();
      setTimeout(() => {
        this.attemptSend(chosenChannel, user_id, template, vars, message_id);
      }, delay > 0 ? delay : 0);
      return { success: true, message_id, status: 'queued' };
    } else {
      await this.attemptSend(chosenChannel, user_id, template, vars, message_id);
      const log = await this.db.get<NotificationLog>(`SELECT status FROM notification_logs WHERE id = ?`, message_id);
      return { success: true, message_id, status: log.status };
    }
  }

  async sendBatch(paramsArray: SendBatchParams[]): Promise<{ success: boolean; sent: number; failed: number; message_ids: string[] }> {
    const results: string[] = [];
    let sent = 0;
    let failed = 0;
    for (const params of paramsArray) {
      try {
        const res = await this.sendSingle(params);
        results.push(res.message_id);
        if (res.status === 'sent' || res.status === 'queued') sent++;
        else failed++;
      } catch (e) {
        failed++;
      }
    }
    return { success: true, sent, failed, message_ids: results };
  }

  async track(params: TrackParams): Promise<NotificationLog | null> {
    const { message_id, status } = params;
    const now = new Date().toISOString();
    if (status === 'opened') {
      await this.updateLogStatus(message_id, { status: 'opened', opened_at: now });
    } else if (status === 'clicked') {
      await this.updateLogStatus(message_id, { status: 'clicked', clicked_at: now });
    } else if (status === 'bounced') {
      await this.updateLogStatus(message_id, { status: 'bounced', bounced: true });
    }
    return await this.db.get<NotificationLog>(`SELECT * FROM notification_logs WHERE id = ?`, message_id);
  }

  async getPreferences(user_id: number): Promise<UserPreferences> {
    return await this.getUserPreferences(user_id);
  }
}