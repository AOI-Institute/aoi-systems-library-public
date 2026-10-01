import { Pool } from 'pg';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import {
  enqueueJob,
  getJobStatus,
  listJobs,
  cancelJob,
  retryJob,
  getJobResults,
  initializeJobManager,
  JobStatus,
  BackgroundJobError
} from './background_jobs_task_queue_typescript';

// In-memory database tables to simulate PostgreSQL
let jobsTable: any[] = [];
let jobRunsTable: any[] = [];
let usersTable: any[] = [];
let notificationsTable: any[] = [];
let webhooksTable: any[] = [];
let webhookAttemptsTable: any[] = [];
let dataExportsTable: any[] = [];
let exportRecordsTable: any[] = [];
let dailyReportsTable: any[] = [];
let userSessionsTable: any[] = [];
let stripeInvoicesTable: any[] = [];
let deploymentArchivesTable: any[] = [];
let deploymentsTable: any[] = [];
let archiveEntriesTable: any[] = [];

// In-memory Redis store
let redisQueue: string[] = [];
let redisScheduled: Record<string, string> = {};

// Mock pg Pool
jest.mock('pg', () => {
  const mockClient = {
    query: jest.fn((sql: string, params: any[] = []) => mockQuery(sql, params)),
    release: jest.fn(),
  };

  return {
    Pool: jest.fn().mockImplementation(() => ({
      query: jest.fn((sql: string, params: any[] = []) => mockQuery(sql, params)),
      connect: jest.fn().mockResolvedValue(mockClient),
    })),
  };
});

// Mock ioredis
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    setex: jest.fn().mockImplementation(async (key: string, seconds: number, value: string) => {
      redisScheduled[key] = value;
      return 'OK';
    }),
    lpush: jest.fn().mockImplementation(async (key: string, value: string) => {
      redisQueue.unshift(value);
      return 1;
    }),
    lrange: jest.fn().mockImplementation(async (key: string, start: number, stop: number) => {
      return redisQueue.slice(start, stop + 1);
    }),
    lrem: jest.fn().mockImplementation(async (key: string, count: number, value: string) => {
      redisQueue = redisQueue.filter(v => v !== value);
      return 1;
    }),
    keys: jest.fn().mockImplementation(async (pattern: string) => {
      return Object.keys(redisScheduled);
    }),
    get: jest.fn().mockImplementation(async (key: string) => {
      return redisScheduled[key] || null;
    }),
    del: jest.fn().mockImplementation(async (key: string) => {
      delete redisScheduled[key];
      return 1;
    }),
    pipeline: jest.fn().mockImplementation(() => ({
      lrem: jest.fn().mockImplementation((key: string, count: number, value: string) => {
        redisQueue = redisQueue.filter(v => v !== value);
      }),
      exec: jest.fn().mockResolvedValue([]),
    })),
  }));
});

// Mock uuid to return predictable IDs if needed, or fallback to real uuid
jest.mock('uuid', () => {
  const actual = jest.requireActual('uuid');
  let counter = 0;
  return {
    v4: jest.fn().mockImplementation(() => {
      counter++;
      return `mock-uuid-${counter}-${actual.v4().slice(0, 8)}`;
    }),
  };
});

// Mock query engine to simulate database operations
async function mockQuery(sql: string, params: any[] = []): Promise<{ rows: any[]; count?: number }> {
  const normalized = sql.replace(/\s+/g, ' ').trim();

  if (normalized.startsWith('CREATE TABLE') || normalized.startsWith('CREATE INDEX')) {
    return { rows: [] };
  }

  if (normalized.startsWith('INSERT INTO jobs')) {
    const job = {
      id: params[0],
      task_type: params[1],
      params: typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2],
      status: params[3],
      created_at: params[4] || new Date(),
      scheduled_at: params[5],
      max_retries: params[6],
      retry_count: params[7],
      next_retry_at: params[8],
      started_at: null,
      completed_at: null,
      progress: null,
      result: null,
      error: null,
    };
    jobsTable.push(job);
    return { rows: [job] };
  }

  if (normalized.startsWith('SELECT * FROM jobs WHERE id = $1')) {
    const job = jobsTable.find(j => j.id === params[0]);
    return { rows: job ? [job] : [] };
  }

  if (normalized.startsWith('SELECT * FROM jobs WHERE 1=1')) {
    let filtered = [...jobsTable];
    let paramIdx = 1;
    if (normalized.includes('status = $')) {
      const statusVal = params[paramIdx - 1];
      filtered = filtered.filter(j => j.status === statusVal);
      paramIdx++;
    }
    if (normalized.includes('task_type = $')) {
      const taskTypeVal = params[paramIdx - 1];
      filtered = filtered.filter(j => j.task_type === taskTypeVal);
      paramIdx++;
    }
    const limit = params[params.length - 1] || 10;
    filtered = filtered.slice(0, limit);
    return { rows: filtered };
  }

  if (normalized.startsWith('SELECT COUNT(*) FROM jobs WHERE 1=1')) {
    let filtered = [...jobsTable];
    let paramIdx = 1;
    if (normalized.includes('status = $')) {
      const statusVal = params[paramIdx - 1];
      filtered = filtered.filter(j => j.status === statusVal);
      paramIdx++;
    }
    if (normalized.includes('task_type = $')) {
      const taskTypeVal = params[paramIdx - 1];
      filtered = filtered.filter(j => j.task_type === taskTypeVal);
      paramIdx++;
    }
    return { rows: [{ count: filtered.length.toString() }] };
  }

  if (normalized.startsWith('UPDATE jobs SET status = $1, error = $2, completed_at = $3 WHERE id = $4 AND status = $5')) {
    const job = jobsTable.find(j => j.id === params[3] && j.status === params[4]);
    if (job) {
      job.status = params[0];
      job.error = params[1];
      job.completed_at = params[2];
      return { rows: [job] };
    }
    return { rows: [] };
  }

  if (normalized.startsWith('UPDATE jobs SET status = $1, started_at = $2 WHERE id = $3')) {
    const job = jobsTable.find(j => j.id === params[2]);
    if (job) {
      job.status = params[0];
      job.started_at = params[1];
    }
    return { rows: [] };
  }

  if (normalized.startsWith('UPDATE jobs SET status = $1, completed_at = $2, result = $3, progress = $4 WHERE id = $5')) {
    const job = jobsTable.find(j => j.id === params[4]);
    if (job) {
      job.status = params[0];
      job.completed_at = params[1];
      job.result = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
      job.progress = params[3];
    }
    return { rows: [] };
  }

  if (normalized.startsWith('UPDATE jobs SET progress = $1 WHERE id = $2')) {
    const job = jobsTable.find(j => j.id === params[1]);
    if (job) {
      job.progress = params[0];
    }
    return { rows: [] };
  }

  if (normalized.startsWith('INSERT INTO job_runs')) {
    const run = {
      id: params[0],
      job_id: params[1],
      status: params[2],
      started_at: params[3],
      completed_at: null,
      result: null,
    };
    jobRunsTable.push(run);
    return { rows: [run] };
  }

  if (normalized.startsWith('UPDATE job_runs SET status = $1, completed_at = $2, result = $3 WHERE id = $4')) {
    const run = jobRunsTable.find(r => r.id === params[3]);
    if (run) {
      run.status = params[0];
      run.completed_at = params[1];
      run.result = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
    }
    return { rows: [] };
  }

  if (normalized.startsWith('UPDATE job_runs SET status = $1, completed_at = $2 WHERE job_id = $3 AND status = $4')) {
    const run = jobRunsTable.find(r => r.job_id === params[2] && r.status === params[3]);
    if (run) {
      run.status = params[0];
      run.completed_at = params[1];
    }
    return { rows: [] };
  }

  if (normalized.startsWith('SELECT COUNT(*) FROM users WHERE trial_days_left <= $1')) {
    const count = usersTable.filter(u => u.trial_days_left <= params[0]).length;
    return { rows: [{ count: count.toString() }] };
  }

  if (normalized.startsWith('SELECT id FROM users WHERE trial_days_left <= $1 LIMIT $2 OFFSET $3')) {
    const filtered = usersTable.filter(u => u.trial_days_left <= params[0]);
    const limit = params[1];
    const offset = params[2];
    const sliced = filtered.slice(offset, offset + limit).map(u => ({ id: u.id }));
    return { rows: sliced };
  }

  if (normalized.startsWith('INSERT INTO notifications')) {
    const notif = {
      user_id: params[0],
      type: params[1],
      template_key: params[2],
      status: params[3],
    };
    notificationsTable.push(notif);
    return { rows: [notif] };
  }

  if (normalized.startsWith('SELECT * FROM webhooks WHERE id = $1')) {
    const wh = webhooksTable.find(w => w.id === params[0]);
    return { rows: wh ? [wh] : [] };
  }

  if (normalized.startsWith('SELECT * FROM webhook_attempts WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 1')) {
    const attempts = webhookAttemptsTable.filter(a => a.webhook_id === params[0]);
    attempts.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return { rows: attempts.length > 0 ? [attempts[0]] : [] };
  }

  if (normalized.startsWith('INSERT INTO webhook_attempts')) {
    const attempt = {
      webhook_id: params[0],
      status: params[1],
      retry_count: params[2],
      next_retry_at: params[3],
      error: params[4],
      created_at: new Date(),
    };
    webhookAttemptsTable.push(attempt);
    return { rows: [attempt] };
  }

  if (normalized.startsWith('INSERT INTO data_exports')) {
    const de = {
      id: params[0],
      type: params[1],
      status: params[2],
      created_at: params[3],
      filters: typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4],
      user_id: params[5],
    };
    dataExportsTable.push(de);
    return { rows: [de] };
  }

  if (normalized.startsWith('SELECT COUNT(*) FROM users WHERE created_at >= $1')) {
    const count = usersTable.filter(u => u.created_at >= params[0]).length;
    return { rows: [{ count: count.toString() }] };
  }

  if (normalized.startsWith('SELECT COUNT(*) FROM orders WHERE created_at >= $1')) {
    return { rows: [{ count: '5' }] };
  }

  if (normalized.startsWith('SELECT * FROM users WHERE created_at >= $1 LIMIT $2 OFFSET $3')) {
    const filtered = usersTable.filter(u => u.created_at >= params[0]);
    const sliced = filtered.slice(params[2], params[2] + params[1]);
    return { rows: sliced };
  }

  if (normalized.startsWith('INSERT INTO export_records')) {
    const er = {
      export_id: params[0],
      record_type: params[1],
      record_id: params[2],
      data: typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3],
      status: params[4],
    };
    exportRecordsTable.push(er);
    return { rows: [er] };
  }

  if (normalized.startsWith('UPDATE data_exports SET status = $1, completed_at = $2 WHERE id = $3')) {
    const de = dataExportsTable.find(d => d.id === params[2]);
    if (de) {
      de.status = params[0];
      de.completed_at = params[1];
    }
    return { rows: [] };
  }

  if (normalized.startsWith('SELECT COUNT(*) FROM users WHERE created_at BETWEEN $1 AND $2')) {
    return { rows: [{ count: '10' }] };
  }

  if (normalized.startsWith('SELECT COALESCE(SUM(amount), 0) FROM orders WHERE created_at BETWEEN $1 AND $2 AND status = $3')) {
    return { rows: [{ coalesce: '150.00' }] };
  }

  if (normalized.startsWith('SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE last_active BETWEEN $1 AND $2')) {
    return { rows: [{ count: '3' }] };
  }

  if (normalized.startsWith('INSERT INTO daily_reports')) {
    const dr = {
      date: params[0],
      total_users: params[1],
      active_users: params[2],
      total_revenue: params[3],
      new_signups: params[4],
      status: params[5],
      data: typeof params[6] === 'string' ? JSON.parse(params[6]) : params[6],
    };
    dailyReportsTable.push(dr);
    return { rows: [dr] };
  }

  if (normalized.startsWith('DELETE FROM user_sessions WHERE last_active < $1 RETURNING user_id')) {
    const cutoff = params[0];
    const toDelete = userSessionsTable.filter(s => s.last_active < cutoff);
    userSessionsTable = userSessionsTable.filter(s => s.last_active >= cutoff);
    return { rows: toDelete };
  }

  if (normalized.startsWith('UPDATE users SET last_session_cleanup = $1 WHERE id = ANY($2)')) {
    const ids = params[1];
    usersTable.forEach(u => {
      if (ids.includes(u.id)) {
        u.last_session_cleanup = params[0];
      }
    });
    return { rows: [] };
  }

  if (normalized.startsWith('DELETE FROM user_sessions WHERE user_id = $1')) {
    userSessionsTable = userSessionsTable.filter(s => s.user_id !== params[0]);
    return { rows: [] };
  }

  if (normalized.startsWith('DELETE FROM notifications WHERE user_id = $1')) {
    notificationsTable = notificationsTable.filter(n => n.user_id !== params[0]);
    return { rows: [] };
  }

  if (normalized.startsWith('DELETE FROM user_preferences WHERE user_id = $1')) {
    return { rows: [] };
  }

  if (normalized.startsWith('DELETE FROM user_activity WHERE user_id = $1')) {
    return { rows: [] };
  }

  if (normalized.startsWith('UPDATE users SET status = $1, deleted_at = $2 WHERE id = $3')) {
    const u = usersTable.find(user => user.id === params[2]);
    if (u) {
      u.status = params[0];
      u.deleted_at = params[1];
    }
    return { rows: [] };
  }

  if (normalized.startsWith('SELECT * FROM stripe_invoices WHERE status = $1 AND created_at >= $2')) {
    const filtered = stripeInvoicesTable.filter(i => i.status === params[0] && i.created_at >= params[1]);
    return { rows: filtered };
  }

  if (normalized.startsWith('SELECT * FROM stripe_invoices WHERE id = $1')) {
    const inv = stripeInvoicesTable.find(i => i.id === params[0]);
    return { rows: inv ? [inv] : [] };
  }

  if (normalized.startsWith('UPDATE stripe_invoices SET last_synced = $1, sync_status = $2 WHERE id = $3')) {
    const inv = stripeInvoicesTable.find(i => i.id === params[2]);
    if (inv) {
      inv.last_synced = params[0];
      inv.sync_status = params[1];
    }
    return { rows: [] };
  }

  if (normalized.startsWith('INSERT INTO deployment_archives')) {
    const da = {
      id: params[0],
      environment: params[1],
      services: typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2],
      status: params[3],
      created_at: params[4],
      user_id: params[5],
    };
    deploymentArchivesTable.push(da);
    return { rows: [da] };
  }

  if (normalized.startsWith('SELECT * FROM deployments WHERE environment = $1')) {
    let filtered = deploymentsTable.filter(d => d.environment === params[0]);
    if (normalized.includes('service_name = ANY($2)')) {
      const services = params[1];
      filtered = filtered.filter(d => services.includes(d.service_name));
    }
    return { rows: filtered };
  }

  if (normalized.startsWith('INSERT INTO archive_entries')) {
    const ae = {
      archive_id: params[0],
      deployment_id: params[1],
      deployment_data: typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2],
      status: params[3],
    };
    archiveEntriesTable.push(ae);
    return { rows: [ae] };
  }

  if (normalized.startsWith('UPDATE deployment_archives SET status = $1, completed_at = $2 WHERE id = $3')) {
    const da = deploymentArchivesTable.find(d => d.id === params[2]);
    if (da) {
      da.status = params[0];
      da.completed_at = params[1];
    }
    return { rows: [] };
  }

  if (normalized.startsWith('UPDATE jobs SET status = $1, error = $2, retry_count = $3, next_retry_at = $4 WHERE id = $5')) {
    const job = jobsTable.find(j => j.id === params[4]);
    if (job) {
      job.status = params[0];
      job.error = params[1];
      job.retry_count = params[2];
      job.next_retry_at = params[3];
    }
    return { rows: [] };
  }

  if (normalized.startsWith('UPDATE jobs SET status = $1, error = $2, completed_at = $3, retry_count = $4 WHERE id = $5')) {
    const job = jobsTable.find(j => j.id === params[4]);
    if (job) {
      job.status = params[0];
      job.error = params[1];
      job.completed_at = params[2];
      job.retry_count = params[3];
    }
    return { rows: [] };
  }

  if (normalized.startsWith('BEGIN') || normalized.startsWith('COMMIT') || normalized.startsWith('ROLLBACK')) {
    return { rows: [] };
  }

  return { rows: [] };
}

describe('Background Jobs & Task Queue Tests', () => {
  let jobManager: any;

  beforeEach(async () => {
    jobsTable = [];
    jobRunsTable = [];
    usersTable = [];
    notificationsTable = [];
    webhooksTable = [];
    webhookAttemptsTable = [];
    dataExportsTable = [];
    exportRecordsTable = [];
    dailyReportsTable = [];
    userSessionsTable = [];
    stripeInvoicesTable = [];
    deploymentArchivesTable = [];
    deploymentsTable = [];
    archiveEntriesTable = [];
    redisQueue = [];
    redisScheduled = {};

    jest.clearAllMocks();

    // Retrieve the singleton instance
    const mod = require('./background_jobs_task_queue_typescript');
    jobManager = mod.JobManager.getInstance();
    // Prevent the background worker loop from running automatically during tests
    jobManager.workerRunning = false;
  });

  test('✓ Enqueue job, worker picks it up, status becomes running', async () => {
    // Enqueue a job
    const enqueueRes = await enqueueJob('cleanup_old_sessions', { days_old: 30 });
    expect(enqueueRes.success).toBe(true);
    expect(enqueueRes.status).toBe(JobStatus.ENQUEUED);

    const jobId = enqueueRes.job_id;

    // Verify it is in the database and Redis queue
    const statusBefore = await getJobStatus(jobId);
    expect(statusBefore.status).toBe(JobStatus.ENQUEUED);
    expect(redisQueue).toContain(jobId);

    // Intercept executeJob to pause execution so we can verify the "running" status
    let resolveExecution: any;
    const executionPromise = new Promise((resolve) => {
      resolveExecution = resolve;
    });

    const originalExecuteJob = (jobManager as any).executeJob;
    jest.spyOn(job