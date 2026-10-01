import { Pool } from 'pg';
import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { format } from 'date-fns';
import { z } from 'zod';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const JobStatus = {
  ENQUEUED: 'enqueued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

type JobStatusType = typeof JobStatus[keyof typeof JobStatus];

const JobSchema = z.object({
  id: z.string().uuid(),
  task_type: z.string(),
  params: z.record(z.any()),
  status: z.enum(['enqueued', 'running', 'completed', 'failed', 'cancelled']),
  created_at: z.date(),
  started_at: z.date().nullable(),
  completed_at: z.date().nullable(),
  progress: z.string().nullable(),
  result: z.record(z.any()).nullable(),
  error: z.string().nullable(),
  retry_count: z.number().int().min(0),
  max_retries: z.number().int().min(0),
  next_retry_at: z.date().nullable(),
  scheduled_at: z.date().nullable(),
});

const JobRunSchema = z.object({
  id: z.string().uuid(),
  job_id: z.string().uuid(),
  status: z.string(),
  started_at: z.date(),
  completed_at: z.date().nullable(),
  result: z.record(z.any()).nullable(),
});

interface Job extends z.infer<typeof JobSchema> {}
interface JobRun extends z.infer<typeof JobRunSchema> {}

class BackgroundJobError extends Error {
  constructor(
    message: string,
    public jobId: string,
    public code: string
  ) {
    super(message);
    this.name = 'BackgroundJobError';
  }
}

class JobManager {
  private static instance: JobManager;
  private workerRunning = false;
  private readonly BATCH_SIZE = 10;
  private readonly RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];

  private constructor() {}

  public static getInstance(): JobManager {
    if (!JobManager.instance) {
      JobManager.instance = new JobManager();
    }
    return JobManager.instance;
  }

  public async initialize(): Promise<void> {
    await this.setupDatabase();
    await this.startWorker();
  }

  private async setupDatabase(): Promise<void> {
    await db.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id VARCHAR(255) PRIMARY KEY,
        task_type VARCHAR(255) NOT NULL,
        params JSONB NOT NULL,
        status VARCHAR(50) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        started_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE,
        progress VARCHAR(50),
        result JSONB,
        error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        next_retry_at TIMESTAMP WITH TIME ZONE,
        scheduled_at TIMESTAMP WITH TIME ZONE
      );

      CREATE TABLE IF NOT EXISTS job_runs (
        id VARCHAR(255) PRIMARY KEY,
        job_id VARCHAR(255) NOT NULL REFERENCES jobs(id),
        status VARCHAR(50) NOT NULL,
        started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP WITH TIME ZONE,
        result JSONB,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_at ON jobs(scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_next_retry_at ON jobs(next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_job_runs_job_id ON job_runs(job_id);
    `);
  }

  public async enqueueJob(
    task_type: string,
    params: Record<string, any>,
    scheduled_at?: Date,
    max_retries?: number
  ): Promise<{ success: boolean; job_id: string; status: string }> {
    const jobId = uuidv4();
    const now = new Date();
    
    const query = `
      INSERT INTO jobs (
        id, task_type, params, status, created_at, 
        scheduled_at, max_retries, retry_count, next_retry_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
    
    const values = [
      jobId,
      task_type,
      JSON.stringify(params),
      JobStatus.ENQUEUED,
      now,
      scheduled_at || null,
      max_retries || 3,
      0,
      scheduled_at && scheduled_at > now ? scheduled_at : null
    ];
    
    const result = await db.query(query, values);
    const job = result.rows[0];
    
    if (scheduled_at && scheduled_at > now) {
      await redis.setex(`job:scheduled:${jobId}`, Math.floor((scheduled_at.getTime() - now.getTime()) / 1000), jobId);
    } else {
      await redis.lpush('job:queue', jobId);
    }
    
    return { success: true, job_id: jobId, status: job.status };
  }

  public async getJobStatus(jobId: string): Promise<any> {
    const query = 'SELECT * FROM jobs WHERE id = $1';
    const result = await db.query(query, [jobId]);
    
    if (result.rows.length === 0) {
      throw new BackgroundJobError('Job not found', jobId, 'JOB_NOT_FOUND');
    }
    
    const job = result.rows[0];
    return {
      job_id: job.id,
      task_type: job.task_type,
      status: job.status,
      progress: job.progress,
      created_at: job.created_at,
      started_at: job.started_at,
      result: job.result,
      next_retry_at: job.next_retry_at
    };
  }

  public async listJobs(
    status?: string,
    task_type?: string,
    limit: number = 10
  ): Promise<{ jobs: any[]; total: number }> {
    let query = 'SELECT * FROM jobs WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;
    
    if (status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }
    
    if (task_type) {
      query += ` AND task_type = $${paramIndex++}`;
      params.push(task_type);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++}`;
    params.push(limit);
    
    const countQuery = 'SELECT COUNT(*) FROM jobs WHERE 1=1';
    const countParams: any[] = [];
    let countParamIndex = 1;
    
    if (status) {
      countQuery += ` AND status = $${countParamIndex++}`;
      countParams.push(status);
    }
    
    if (task_type) {
      countQuery += ` AND task_type = $${countParamIndex++}`;
      countParams.push(task_type);
    }
    
    const [jobsResult, countResult] = await Promise.all([
      db.query(query, params),
      db.query(countQuery, countParams)
    ]);
    
    return {
      jobs: jobsResult.rows.map(this.formatJobResponse),
      total: parseInt(countResult.rows[0].count)
    };
  }

  public async cancelJob(jobId: string): Promise<{ success: boolean; status: string }> {
    const query = `
      UPDATE jobs 
      SET status = $1, error = $2, completed_at = $3
      WHERE id = $4 AND status = $5
      RETURNING *
    `;
    
    const values = [
      JobStatus.CANCELLED,
      'Job cancelled by user',
      new Date(),
      jobId,
      JobStatus.ENQUEUED
    ];
    
    const result = await db.query(query, values);
    
    if (result.rows.length === 0) {
      throw new BackgroundJobError('Cannot cancel job', jobId, 'JOB_ALREADY_STARTED');
    }
    
    await redis.del(`job:scheduled:${jobId}`);
    await redis.lrem('job:queue', 0, jobId);
    
    return { success: true, status: JobStatus.CANCELLED };
  }

  public async retryJob(jobId: string): Promise<{ success: boolean; new_job_id: string; status: string }> {
    const query = 'SELECT * FROM jobs WHERE id = $1';
    const result = await db.query(query, [jobId]);
    
    if (result.rows.length === 0) {
      throw new BackgroundJobError('Job not found', jobId, 'JOB_NOT_FOUND');
    }
    
    const job = result.rows[0];
    
    if (job.status !== JobStatus.FAILED) {
      throw new BackgroundJobError('Can only retry failed jobs', jobId, 'INVALID_JOB_STATUS');
    }
    
    const newJobId = uuidv4();
    const now = new Date();
    
    const insertQuery = `
      INSERT INTO jobs (
        id, task_type, params, status, created_at, 
        scheduled_at, max_retries, retry_count, next_retry_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
    
    const insertValues = [
      newJobId,
      job.task_type,
      job.params,
      JobStatus.ENQUEUED,
      now,
      job.scheduled_at,
      job.max_retries,
      0,
      null
    ];
    
    const insertResult = await db.query(insertQuery, insertValues);
    await redis.lpush('job:queue', newJobId);
    
    return { success: true, new_job_id: newJobId, status: JobStatus.ENQUEUED };
  }

  public async getJobResults(jobId: string): Promise<any> {
    const query = 'SELECT * FROM jobs WHERE id = $1';
    const result = await db.query(query, [jobId]);
    
    if (result.rows.length === 0) {
      throw new BackgroundJobError('Job not found', jobId, 'JOB_NOT_FOUND');
    }
    
    const job = result.rows[0];
    
    if (job.status !== JobStatus.COMPLETED) {
      throw new BackgroundJobError('Results only available for completed jobs', jobId, 'JOB_NOT_COMPLETED');
    }
    
    return {
      job_id: job.id,
      status: job.status,
      result: job.result,
      completed_at: job.completed_at
    };
  }

  private formatJobResponse(job: any): any {
    return {
      job_id: job.id,
      task_type: job.task_type,
      status: job.status,
      progress: job.progress,
      created_at: job.created_at,
      started_at: job.started_at,
      result: job.result,
      next_retry_at: job.next_retry_at
    };
  }

  private async startWorker(): Promise<void> {
    if (this.workerRunning) return;
    this.workerRunning = true;
    
    const processWorker = async () => {
      while (this.workerRunning) {
        try {
          await this.processJobs();
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error('Worker error:', error);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    };
    
    processWorker();
  }

  private async processJobs(): Promise<void> {
    const pipeline = redis.pipeline();
    
    const queueJobs = await redis.lrange('job:queue', 0, this.BATCH_SIZE - 1);
    const scheduledJobs = await redis.keys('job:scheduled:*');
    
    for (const jobId of queueJobs) {
      pipeline.lrem('job:queue', 0, jobId);
    }
    
    await pipeline.exec();
    
    for (const jobId of queueJobs) {
      await this.processJob(jobId);
    }
    
    for (const key of scheduledJobs) {
      const scheduledJobId = key.split(':')[2];
      const scheduledTime = await redis.get(key);
      const now = new Date();
      
      if (scheduledTime && new Date(parseInt(scheduledTime)) <= now) {
        await redis.del(key);
        await redis.lpush('job:queue', scheduledJobId);
      }
    }
  }

  private async processJob(jobId: string): Promise<void> {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      const query = 'SELECT * FROM jobs WHERE id = $1 FOR UPDATE';
      const result = await client.query(query, [jobId]);
      
      if (result.rows.length === 0) {
        return;
      }
      
      const job = result.rows[0];
      
      if (job.status !== JobStatus.ENQUEUED) {
        return;
      }
      
      if (job.scheduled_at && job.scheduled_at > new Date()) {
        await client.query('COMMIT');
        return;
      }
      
      const jobRunId = uuidv4();
      const startedAt = new Date();
      
      await client.query(
        'INSERT INTO job_runs (id, job_id, status, started_at) VALUES ($1, $2, $3, $4)',
        [jobRunId, jobId, 'running', startedAt]
      );
      
      await client.query(
        'UPDATE jobs SET status = $1, started_at = $2 WHERE id = $3',
        [JobStatus.RUNNING, startedAt, jobId]
      );
      
      await client.query('COMMIT');
      
      const resultData = await this.executeJob(job);
      
      await client.query('BEGIN');
      
      await client.query(
        'UPDATE job_runs SET status = $1, completed_at = $2, result = $3 WHERE id = $4',
        [JobStatus.COMPLETED, new Date(), JSON.stringify(resultData), jobRunId]
      );
      
      await client.query(
        'UPDATE jobs SET status = $1, completed_at = $2, result = $3, progress = $4 WHERE id = $5',
        [JobStatus.COMPLETED, new Date(), JSON.stringify(resultData), '100/100', jobId]
      );
      
      await client.query('COMMIT');
      
    } catch (error) {
      await client.query('ROLLBACK');
      
      if (error instanceof BackgroundJobError) {
        throw error;
      }
      
      await this.handleJobError(jobId, error as Error);
    } finally {
      client.release();
    }
  }

  private async executeJob(job: Job): Promise<any> {
    switch (job.task_type) {
      case 'send_bulk_email':
        return await this.sendBulkEmail(job);
      case 'webhook_retry':
        return await this.webhookRetry(job);
      case 'export_generate':
        return await this.exportGenerate(job);
      case 'daily_report':
        return await this.dailyReport(job);
      case 'cleanup_old_sessions':
        return await this.cleanupOldSessions(job);
      case 'delete_user_cascade':
        return await this.deleteUserCascade(job);
      case 'sync_stripe_invoices':
        return await this.syncStripeInvoices(job);
      case 'generate_deployment_archive':
        return await this.generateDeploymentArchive(job);
      default:
        throw new BackgroundJobError(`Unknown task type: ${job.task_type}`, job.id, 'UNKNOWN_TASK_TYPE');
    }
  }

  private async sendBulkEmail(job: Job): Promise<any> {
    const params = job.params;
    const filter = params.filter || {};
    
    const { rows } = await db.query(
      'SELECT COUNT(*) FROM users WHERE trial_days_left <= $1',
      [filter.trial_days_left?.$lte || 7]
    );
    
    const total = parseInt(rows[0].count);
    const batchSize = 100;
    let processed = 0;
    
    for (let i = 0; i < total; i += batchSize) {
      const batch = await db.query(
        'SELECT id FROM users WHERE trial_days_left <= $1 LIMIT $2 OFFSET $3',
        [filter.trial_days_left?.$lte || 7, batchSize, i]
      );
      
      for (const user of batch.rows) {
        await this.sendEmailToUser(user.id, params.template_key);
        processed++;
        
        const progress = `${processed}/${total}`;
        await db.query(
          'UPDATE jobs SET progress = $1 WHERE id = $2',
          [progress, job.id]
        );
      }
    }
    
    return {
      sent: total,
      failed: 0,
      template_key: params.template_key
    };
  }

  private async sendEmailToUser(userId: string, templateKey: string): Promise<void> {
    await db.query(
      'INSERT INTO notifications (user_id, type, template_key, status) VALUES ($1, $2, $3, $4)',
      [userId, 'email', templateKey, 'sent']
    );
  }

  private async webhookRetry(job: Job): Promise<any> {
    const params = job.params;
    const webhookId = params.webhook_id;
    
    const { rows } = await db.query(
      'SELECT * FROM webhooks WHERE id = $1',
      [webhookId]
    );
    
    if (rows.length === 0) {
      throw new BackgroundJobError(`Webhook not found: ${webhookId}`, job.id, 'WEBHOOK_NOT_FOUND');
    }
    
    const webhook = rows[0];
    
    const { rows: attempts } = await db.query(
      'SELECT * FROM webhook_attempts WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 1',
      [webhookId]
    );
    
    const lastAttempt = attempts[0];
    const maxRetries = webhook.max_retries || 3;
    const retryCount = lastAttempt ? lastAttempt.retry_count + 1 : 1;
    
    if (retryCount > maxRetries) {
      return {
        webhook_id: webhookId,
        status: 'failed',
        attempts: retryCount,
        error: 'Max retries exceeded'
      };
    }
    
    const backoffDelay = Math.min(1000 * Math.pow(2, retryCount - 1), 300000);
    
    await db.query(
      `INSERT INTO webhook_attempts (
        webhook_id, status, retry_count, next_retry_at, error
      ) VALUES ($1, $2, $3, $4, $5)`,
      [
        webhookId,
        'pending',
        retryCount,
        new Date(Date.now() + backoffDelay),
        null
      ]
    );
    
    return {
      webhook_id: webhookId,
      status: 'queued',
      attempts: retryCount,
      next_retry_at: new Date(Date.now() + backoffDelay)
    };
  }

  private async exportGenerate(job: Job): Promise<any> {
    const params = job.params;
    const exportType = params.export_type;
    const filters = params.filters || {};
    
    const exportId = uuidv4();
    const createdAt = new Date();
    
    await db.query(
      `INSERT INTO data_exports (
        id, type, status, created_at, filters, user_id
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        exportId,
        exportType,
        'processing',
        createdAt,
        JSON.stringify(filters),
        params.user_id
      ]
    );
    
    const totalRecords = await this.getExportRecordCount(exportType, filters);
    let processed = 0;
    
    while (processed < totalRecords) {
      const batch = await this.getExportBatch(exportType, filters, processed, 1000);
      
      for (const record of batch) {
        await this.processExportRecord(exportId, record, exportType);
        processed++;
        
        const progress = `${processed}/${totalRecords}`;
        await db.query(
          'UPDATE jobs SET progress = $1 WHERE id = $2',
          [progress, job.id]
        );
      }
    }
    
    await db.query(
      'UPDATE data_exports SET status = $1, completed_at = $2 WHERE id = $3',
      ['completed', new Date(), exportId]
    );
    
    return {
      export_id: exportId,
      type: exportType,
      total_records: totalRecords,
      processed: totalRecords
    };
  }

  private async getExportRecordCount(exportType: string, filters: any): Promise<number> {
    switch (exportType) {
      case 'users':
        return parseInt((await db.query(
          'SELECT COUNT(*) FROM users WHERE created_at >= $1',
          [filters.created_after || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)]
        )).rows[0].count);
      case 'orders':
        return parseInt((await db.query(
          'SELECT COUNT(*) FROM orders WHERE created_at >= $1',
          [filters.created_after || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)]
        )).rows[0].count);
      default:
        return 0;
    }
  }

  private async getExportBatch(exportType: string, filters: any, offset: number, limit: number): Promise<any[]> {
    switch (exportType) {
      case 'users':
        return (await db.query(
          'SELECT * FROM users WHERE created_at >= $1 LIMIT $2 OFFSET $3',
          [
            filters.created_after || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            limit,
            offset
          ]
        )).rows;
      case 'orders':
        return (await db.query(
          'SELECT * FROM orders WHERE created_at >= $1 LIMIT $2 OFFSET $3',
          [
            filters.created_after || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            limit,
            offset
          ]
        )).rows;
      default:
        return [];
    }
  }

  private async processExportRecord(exportId: string, record: any, exportType: string): Promise<void> {
    await db.query(
      `INSERT INTO export_records (
        export_id, record_type, record_id, data, status
      ) VALUES ($1, $2, $3, $4, $5)`,
      [
        exportId,
        exportType,
        record.id,
        JSON.stringify(record),
        'processed'
      ]
    );
  }

  private async dailyReport(job: Job): Promise<any> {
    const params = job.params;
    const reportDate = params.report_date ? new Date(params.report_date) : new Date();
    
    const metrics = await this.calculateDailyMetrics(reportDate);
    
    await db.query(
      `INSERT INTO daily_reports (
        date, total_users, active_users, total_revenue, 
        new_signups, status, data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        reportDate,
        metrics.total_users,
        metrics.active_users,
        metrics.total_revenue,
        metrics.new_signups,
        'completed',
        JSON.stringify(metrics)
      ]
    );
    
    return {
      report_date: reportDate.toISOString(),
      metrics
    };
  }

  private async calculateDailyMetrics(date: Date): Promise<any> {
    const startOfDay = new Date(date.setHours(0, 0, 0, 0));
    const endOfDay = new Date(date.setHours(23, 59, 59, 999));
    
    const [usersResult, ordersResult, signupsResult] = await Promise.all([
      db.query(
        'SELECT COUNT(*) FROM users WHERE created_at BETWEEN $1 AND $2',
        [startOfDay, endOfDay]
      ),
      db.query(
        'SELECT COALESCE(SUM(amount), 0) FROM orders WHERE created_at BETWEEN $1 AND $2 AND status = $3',
        [startOfDay, endOfDay, 'completed']
      ),
      db.query(
        'SELECT COUNT(*) FROM users WHERE created_at BETWEEN $1 AND $2',
        [startOfDay, endOfDay]
      )
    ]);
    
    const activeUsers = parseInt((await db.query(
      'SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE last_active BETWEEN $1 AND $2',
      [startOfDay, endOfDay]
    )).rows[0].count);
    
    return {
      total_users: parseInt(usersResult.rows[0].count),
      active_users: activeUsers,
      total_revenue: parseFloat(ordersResult.rows[0].coalesce),
      new_signups: parseInt(signupsResult.rows[0].count)
    };
  }

  private async cleanupOldSessions(job: Job): Promise<any> {
    const params = job.params;
    const daysOld = params.days_old || 30;
    const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
    
    const { rows } = await db.query(
      'DELETE FROM user_sessions WHERE last_active < $1 RETURNING user_id',
      [cutoffDate]
    );
    
    const userIds = rows.map(row => row.user_id);
    
    if (userIds.length > 0) {
      await db.query(
        'UPDATE users SET last_session_cleanup = $1 WHERE id = ANY($2)',
        [new Date(), userIds]
      );
    }
    
    return {
      sessions_cleaned: rows.length,
      cutoff_date: cutoffDate.toISOString()
    };
  }

  private async deleteUserCascade(job: Job): Promise<any> {
    const params = job.params;
    const userId = params.user_id;
    
    await db.query('BEGIN');
    
    try {
      await db.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM user_preferences WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM user_activity WHERE user_id = $1', [userId]);
      
      await db.query(
        'UPDATE users SET status = $1, deleted_at = $2 WHERE id = $3',
        ['deleted', new Date(), userId]
      );
      
      await db.query('COMMIT');
      
      return {
        user_id: userId,
        deleted_at: new Date().toISOString(),
        items_deleted: 4
      };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  }

  private async syncStripeInvoices(job: Job): Promise<any> {
    const params = job.params;
    const daysBack = params.days_back || 7;
    const cutoffDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    
    const { rows: invoices } = await db.query(
      'SELECT * FROM stripe_invoices WHERE status = $1 AND created_at >= $2',
      ['open', cutoffDate]
    );
    
    let processed = 0;
    
    for (const invoice of invoices) {
      try {
        const synced = await this.syncStripeInvoice(invoice.id);
        processed++;
        
        const progress = `${processed}/${invoices.length}`;
        await db.query(
          'UPDATE jobs SET progress = $1 WHERE id = $2',
          [progress, job.id]
        );
      } catch (error) {
        console.error(`Failed to sync invoice ${invoice.id}:`, error);
      }
    }
    
    return {
      invoices_processed: processed,
      total_invoices: invoices.length,
      cutoff_date: cutoffDate.toISOString()
    };
  }

  private async syncStripeInvoice(invoiceId: string): Promise<any> {
    const { rows } = await db.query(
      'SELECT * FROM stripe_invoices WHERE id = $1',
      [invoiceId]
    );
    
    if (rows.length === 0) {
      throw new BackgroundJobError(`Invoice not found: ${invoiceId}`, '', 'INVOICE_NOT_FOUND');
    }
    
    const invoice = rows[0];
    
    const syncedData = {
      ...invoice,
      last_synced: new Date(),
      sync_status: 'synced'
    };
    
    await db.query(
      'UPDATE stripe_invoices SET last_synced = $1, sync_status = $2 WHERE id = $3',
      [new Date(), 'synced', invoiceId]
    );
    
    return syncedData;
  }

  private async generateDeploymentArchive(job: Job): Promise<any> {
    const params = job.params;
    const environment = params.environment;
    const services = params.services || [];
    
    const archiveId = uuidv4();
    const createdAt = new Date();
    
    await db.query(
      `INSERT INTO deployment_archives (
        id, environment, services, status, created_at, user_id
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        archiveId,
        environment,
        JSON.stringify(services),
        'creating',
        createdAt,
        params.user_id
      ]
    );
    
    const deployments = await this.getDeploymentsForArchive(environment, services);
    let processed = 0;
    
    for (const deployment of deployments) {
      await this.createArchiveEntry(archiveId, deployment);
      processed++;
      
      const progress = `${processed}/${deployments.length}`;
      await db.query(
        'UPDATE jobs SET progress = $1 WHERE id = $2',
        [progress, job.id]
      );
    }
    
    await db.query(
      'UPDATE deployment_archives SET status = $1, completed_at = $2 WHERE id = $3',
      ['completed', new Date(), archiveId]
    );
    
    return {
      archive_id: archiveId,
      environment,
      services,
      deployments_count: deployments.length,
      processed: deployments.length
    };
  }

  private async getDeploymentsForArchive(environment: string, services: string[]): Promise<any[]> {
    let query = 'SELECT * FROM deployments WHERE environment = $1';
    const params: any[] = [environment];
    
    if (services.length > 0) {
      query += ' AND service_name = ANY($2)';
      params.push(services);
    }
    
    query += ' ORDER BY created_at DESC';
    
    const { rows } = await db.query(query, params);
    return rows;
  }

  private async createArchiveEntry(archiveId: string, deployment: any): Promise<void> {
    await db.query(
      `INSERT INTO archive_entries (
        archive_id, deployment_id, deployment_data, status
      ) VALUES ($1, $2, $3, $4)`,
      [
        archiveId,
        deployment.id,
        JSON.stringify(deployment),
        'included'
      ]
    );
  }

  private async handleJobError(jobId: string, error: Error): Promise<void> {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      const query = 'SELECT * FROM jobs WHERE id = $1 FOR UPDATE';
      const result = await client.query(query, [jobId]);
      
      if (result.rows.length === 0) {
        return;
      }
      
      const job = result.rows[0];
      
      const retryCount = job.retry_count + 1;
      const maxRetries = job.max_retries;
      
      if (retryCount > maxRetries) {
        await client.query(
          `UPDATE jobs SET 
            status = $1, 
            error = $2, 
            completed_at = $3,
            retry_count = $4
          WHERE id = $5`,
          [
            JobStatus.FAILED,
            error.message,
            new Date(),
            retryCount,
            jobId
          ]
        );
        
        await client.query(
          'UPDATE job_runs SET status = $1, completed_at = $2 WHERE job_id = $3 AND status = $4',
          [JobStatus.FAILED, new Date(), jobId, 'running']
        );
        
        await client.query('COMMIT');
        return;
      }
      
      const backoffDelay = this.RETRY_DELAYS[Math.min(retryCount - 1, this.RETRY_DELAYS.length - 1)];
      const nextRetryAt = new Date(Date.now() + backoffDelay);
      
      await client.query(
        `UPDATE jobs SET 
          status = $1,
          error = $2,
          retry_count = $3,
          next_retry_at = $4
        WHERE id = $5`,
        [
          JobStatus.ENQUEUED,
          error.message,
          retryCount,
          nextRetryAt,
          jobId
        ]
      );
      
      await client.query('COMMIT');
      
      await redis.lpush('job:queue', jobId);
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

const jobManager = JobManager.getInstance();

export const enqueueJob = async (task_type: string, params: Record<string, any>, scheduled_at?: Date, max_retries?: number) => {
  return await jobManager.enqueueJob(task_type, params, scheduled_at, max_retries);
};

export const getJobStatus = async (jobId: string) => {
  return await jobManager.getJobStatus(jobId);
};

export const listJobs = async (status?: string, task_type?: string, limit?: number) => {
  return await jobManager.listJobs(status, task_type, limit);
};

export const cancelJob = async (jobId: string) => {
  return await jobManager.cancelJob(jobId);
};

export const retryJob = async (jobId: string) => {
  return await jobManager.retryJob(jobId);
};

export const getJobResults = async (jobId: string) => {
  return await jobManager.getJobResults(jobId);
};

export const initializeJobManager = async () => {
  await jobManager.initialize();
};

export { JobStatus, BackgroundJobError };=== FILE: background_jobs_task_queue_typescript_tests.ts ===
```typescript
import { Pool } from 'pg';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { BackgroundJobError, JobStatus, initializeJobManager } from './background_jobs_task_queue_typescript';

jest.mock('pg');
jest.mock('ioredis');
jest.mock('uuid');

const mockDb = {
  query: jest.fn(),
  connect: jest.fn(),
};

const mockRedis = {
  setex: jest.fn(),
  lpush: jest.fn(),
  lrange: jest.fn(),
  lrem: jest.fn(),
  keys: jest.fn(),
  del: jest.fn(),
  pipeline: jest.fn(),
};

describe('Background Job Manager', () => {
  let jobManager: any;
  
  beforeEach(() => {
    jest.clearAllMocks();
    
    (Pool as jest.MockedClass<typeof Pool>).mockImplementation(() => mockDb as any);
    (Redis as jest.MockedClass<typeof Redis>).mockImplementation(() => mockRedis as any);
    (uuidv4 as jest.Mock).mockReturnValue('test-uuid-123');
    
    jobManager = require('./background_jobs_task_queue_typescript').JobManager.getInstance();
    jobManager.workerRunning = false;
  });
  
  afterEach(() => {
    jest.resetModules();
  });
  
  describe('initialize', () => {
    it('should setup database and start worker', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      
      await jobManager.initialize();
      
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS jobs')
      );
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS job_runs')
      );
    });
  });
  
  describe('enqueueJob', () => {
    it('should enqueue a job successfully', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'send_bulk_email',
        params: { template_key: 'trial_ending_soon' },
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        scheduled_at: null,
        max_retries: 3,
        retry_count: 0,
        next_retry_at: null
      };
      
      mockDb.query.mockResolvedValue({ rows: [mockJob] });
      
      const result = await jobManager.enqueueJob('send_bulk_email', { template_key: 'trial_ending_soon' });
      
      expect(result).toEqual({
        success: true,
        job_id: 'test-uuid-123',
        status: JobStatus.ENQUEUED
      });
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO jobs'),
        expect.any(Array)
      );
    });
    
    it('should schedule a job for future execution', async () => {
      const scheduledAt = new Date(Date.now() + 3600000);
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'send_bulk_email',
        params: { template_key: 'trial_ending_soon' },
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        scheduled_at: scheduledAt,
        max_retries: 3,
        retry_count: 0,
        next_retry_at: null
      };
      
      mockDb.query.mockResolvedValue({ rows: [mockJob] });
      mockRedis.setex.mockResolvedValue('OK');
      
      const result = await jobManager.enqueueJob('send_bulk_email', { template_key: 'trial_ending_soon' }, scheduledAt);
      
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'job:scheduled:test-uuid-123',
        expect.any(Number),
        'test-uuid-123'
      );
    });
  });
  
  describe('getJobStatus', () => {
    it('should return job status', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'send_bulk_email',
        params: { template_key: 'trial_ending_soon' },
        status: JobStatus.RUNNING,
        created_at: new Date(),
        started_at: new Date(),
        completed_at: null,
        progress: '50/100',
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      mockDb.query.mockResolvedValue({ rows: [mockJob] });
      
      const result = await jobManager.getJobStatus('test-uuid-123');
      
      expect(result).toEqual({
        job_id: 'test-uuid-123',
        task_type: 'send_bulk_email',
        status: JobStatus.RUNNING,
        progress: '50/100',
        created_at: mockJob.created_at,
        started_at: mockJob.started_at,
        result: null,
        next_retry_at: null
      });
    });
    
    it('should throw error if job not found', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      
      await expect(jobManager.getJobStatus('non-existent')).rejects.toThrow(BackgroundJobError);
      await expect(jobManager.getJobStatus('non-existent')).rejects.toThrow('Job not found');
    });
  });
  
  describe('listJobs', () => {
    it('should list jobs with filters', async () => {
      const mockJobs = [
        {
          id: 'test-uuid-1',
          task_type: 'send_bulk_email',
          params: {},
          status: JobStatus.COMPLETED,
          created_at: new Date(),
          started_at: new Date(),
          completed_at: new Date(),
          progress: '100/100',
          result: { sent: 100 },
          error: null,
          retry_count: 0,
          max_retries: 3,
          next_retry_at: null,
          scheduled_at: null
        },
        {
          id: 'test-uuid-2',
          task_type: 'send_bulk_email',
          params: {},
          status: JobStatus.RUNNING,
          created_at: new Date(),
          started_at: new Date(),
          completed_at: null,
          progress: '50/100',
          result: null,
          error: null,
          retry_count: 0,
          max_retries: 3,
          next_retry_at: null,
          scheduled_at: null
        }
      ];
      
      const mockCount = { rows: [{ count: '2' }] };
      
      mockDb.query
        .mockResolvedValueOnce({ rows: mockJobs })
        .mockResolvedValueOnce({ rows: mockCount });
      
      const result = await jobManager.listJobs(JobStatus.RUNNING, 'send_bulk_email', 10);
      
      expect(result.jobs).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });
  });
  
  describe('cancelJob', () => {
    it('should cancel a pending job', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'send_bulk_email',
        params: {},
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        started_at: null,
        completed_at: null,
        progress: null,
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      mockDb.query.mockResolvedValue({ rows: [mockJob] });
      
      const result = await jobManager.cancelJob('test-uuid-123');
      
      expect(result).toEqual({
        success: true,
        status: JobStatus.CANCELLED
      });
      expect(mockRedis.lrem).toHaveBeenCalledWith('job:queue', 0, 'test-uuid-123');
    });
    
    it('should not cancel a running job', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'send_bulk_email',
        params: {},
        status: JobStatus.RUNNING,
        created_at: new Date(),
        started_at: new Date(),
        completed_at: null,
        progress: '50/100',
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      mockDb.query.mockResolvedValue({ rows: [] });
      
      await expect(jobManager.cancelJob('test-uuid-123')).rejects.toThrow(BackgroundJobError);
      await expect(jobManager.cancelJob('test-uuid-123')).rejects.toThrow('Cannot cancel job');
    });
  });
  
  describe('retryJob', () => {
    it('should retry a failed job', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'send_bulk_email',
        params: { template_key: 'trial_ending_soon' },
        status: JobStatus.FAILED,
        created_at: new Date(),
        started_at: new Date(),
        completed_at: new Date(),
        progress: null,
        result: null,
        error: 'Something went wrong',
        retry_count: 3,
        max_retries: 5,
        next_retry_at: null,
        scheduled_at: null
      };
      
      const mockNewJob = {
        ...mockJob,
        id: 'test-uuid-456',
        status: JobStatus.ENQUEUED,
        retry_count: 0,
        next_retry_at: null
      };
      
      mockDb.query
        .mockResolvedValueOnce({ rows: [mockJob] })
        .mockResolvedValueOnce({ rows: [mockNewJob] });
      
      const result = await jobManager.retryJob('test-uuid-123');
      
      expect(result).toEqual({
        success: true,
        new_job_id: 'test-uuid-456',
        status: JobStatus.ENQUEUED
      });
      expect(mockRedis.lpush).toHaveBeenCalledWith('job:queue', 'test-uuid-456');
    });
    
    it('should not retry a non-failed job', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'send_bulk_email',
        params: {},
        status: JobStatus.COMPLETED,
        created_at: new Date(),
        started_at: new Date(),
        completed_at: new Date(),
        progress: '100/100',
        result: { sent: 100 },
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      mockDb.query.mockResolvedValue({ rows: [mockJob] });
      
      await expect(jobManager.retryJob('test-uuid-123')).rejects.toThrow(BackgroundJobError);
      await expect(jobManager.retryJob('test-uuid-123')).rejects.toThrow('Can only retry failed jobs');
    });
  });
  
  describe('getJobResults', () => {
    it('should return results for completed job', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'send_bulk_email',
        params: {},
        status: JobStatus.COMPLETED,
        created_at: new Date(),
        started_at: new Date(),
        completed_at: new Date(),
        progress: '100/100',
        result: { sent: 100, failed: 0 },
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      mockDb.query.mockResolvedValue({ rows: [mockJob] });
      
      const result = await jobManager.getJobResults('test-uuid-123');
      
      expect(result).toEqual({
        job_id: 'test-uuid-123',
        status: JobStatus.COMPLETED,
        result: { sent: 100, failed: 0 },
        completed_at: mockJob.completed_at
      });
    });
    
    it('should not return results for non-completed job', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'send_bulk_email',
        params: {},
        status: JobStatus.RUNNING,
        created_at: new Date(),
        started_at: new Date(),
        completed_at: null,
        progress: '50/100',
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      mockDb.query.mockResolvedValue({ rows: [mockJob] });
      
      await expect(jobManager.getJobResults('test-uuid-123')).rejects.toThrow(BackgroundJobError);
      await expect(jobManager.getJobResults('test-uuid-123')).rejects.toThrow('Results only available for completed jobs');
    });
  });
  
  describe('processJob', () => {
    it('should process a job successfully', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'send_bulk_email',
        params: { template_key: 'trial_ending_soon' },
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        started_at: null,
        completed_at: null,
        progress: null,
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      const mockJobRun = {
        id: 'test-uuid-456',
        job_id: 'test-uuid-123',
        status: 'running',
        started_at: new Date(),
        completed_at: null,
        result: null
      };
      
      const mockCount = { rows: [{ count: '100' }] };
      const mockBatch = { rows: [{ id: 'user-1' }, { id: 'user-2' }] };
      
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [mockJob] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [mockJobRun] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: mockCount })
          .mockResolvedValueOnce({ rows: mockBatch })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] }),
        release: jest.fn(),
      };
      
      mockDb.connect.mockResolvedValue(mockClient as any);
      
      await jobManager.processJob('test-uuid-123');
      
      expect(mockClient.query).toHaveBeenCalledWith(
        'BEGIN'
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT * FROM jobs WHERE id = $1 FOR UPDATE',
        ['test-uuid-123']
      );
    });
  });
  
  describe('handleJobError', () => {
    it('should handle job error and retry', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'send_bulk_email',
        params: {},
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        started_at: null,
        completed_at: null,
        progress: null,
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [mockJob] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] }),
        release: jest.fn(),
      };
      
      mockDb.connect.mockResolvedValue(mockClient as any);
      
      await jobManager.handleJobError('test-uuid-123', new Error('Test error'));
      
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE jobs SET'),
        expect.any(Array)
      );
    });
    
    it('should mark job as failed after max retries exceeded', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'send_bulk_email',
        params: {},
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        started_at: null,
        completed_at: null,
        progress: null,
        result: null,
        error: null,
        retry_count: 5,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [mockJob] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] }),
        release: jest.fn(),
      };
      
      mockDb.connect.mockResolvedValue(mockClient as any);
      
      await jobManager.handleJobError('test-uuid-123', new Error('Test error'));
      
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE jobs SET status = $1'),
        expect.any(Array)
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE job_runs SET status = $1'),
        expect.any(Array)
      );
    });
  });
  
  describe('executeJob', () => {
    it('should execute send_bulk_email task', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'send_bulk_email',
        params: { template_key: 'trial_ending_soon' },
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        started_at: null,
        completed_at: null,
        progress: null,
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      const mockCount = { rows: [{ count: '100' }] };
      const mockBatch = { rows: [{ id: 'user-1' }, { id: 'user-2' }] };
      
      mockDb.query
        .mockResolvedValueOnce({ rows: mockCount })
        .mockResolvedValueOnce({ rows: mockBatch })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await jobManager.executeJob(mockJob);
      
      expect(result).toEqual({
        sent: 100,
        failed: 0,
        template_key: 'trial_ending_soon'
      });
    });
    
    it('should execute webhook_retry task', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'webhook_retry',
        params: { webhook_id: 'webhook-123' },
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        started_at: null,
        completed_at: null,
        progress: null,
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      const mockWebhook = {
        id: 'webhook-123',
        max_retries: 3
      };
      
      const mockAttempt = {
        id: 'attempt-123',
        retry_count: 1
      };
      
      mockDb.query
        .mockResolvedValueOnce({ rows: [mockWebhook] })
        .mockResolvedValueOnce({ rows: [mockAttempt] })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await jobManager.executeJob(mockJob);
      
      expect(result).toHaveProperty('webhook_id', 'webhook-123');
      expect(result).toHaveProperty('status', 'queued');
    });
    
    it('should execute export_generate task', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'export_generate',
        params: { export_type: 'users' },
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        started_at: null,
        completed_at: null,
        progress: null,
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      const mockCount = { rows: [{ count: '50' }] };
      const mockBatch = { rows: [{ id: 'user-1' }, { id: 'user-2' }] };
      const mockExport = {
        id: 'export-123',
        type: 'users',
        status: 'processing',
        created_at: new Date(),
        filters: {},
        user_id: 'user-123'
      };
      
      mockDb.query
        .mockResolvedValueOnce({ rows: mockCount })
        .mockResolvedValueOnce({ rows: mockBatch })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [mockExport] });
      
      const result = await jobManager.executeJob(mockJob);
      
      expect(result).toHaveProperty('export_id', 'export-123');
      expect(result).toHaveProperty('type', 'users');
      expect(result).toHaveProperty('total_records', 50);
    });
    
    it('should execute daily_report task', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'daily_report',
        params: { report_date: '2026-09-25' },
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        started_at: null,
        completed_at: null,
        progress: null,
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      const mockMetrics = {
        total_users: 100,
        active_users: 75,
        total_revenue: 5000.00,
        new_signups: 10
      };
      
      const mockReport = {
        id: 'report-123',
        date: new Date('2026-09-25'),
        total_users: 100,
        active_users: 75,
        total_revenue: 5000.00,
        new_signups: 10,
        status: 'completed',
        data: JSON.stringify(mockMetrics)
      };
      
      mockDb.query
        .mockResolvedValueOnce({ rows: [mockReport] });
      
      const result = await jobManager.executeJob(mockJob);
      
      expect(result).toHaveProperty('report_date', '2026-09-25');
      expect(result.metrics).toEqual(mockMetrics);
    });
    
    it('should execute cleanup_old_sessions task', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'cleanup_old_sessions',
        params: { days_old: 30 },
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        started_at: null,
        completed_at: null,
        progress: null,
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      const mockSessions = [
        { user_id: 'user-1' },
        { user_id: 'user-2' }
      ];
      
      mockDb.query
        .mockResolvedValueOnce({ rows: mockSessions })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await jobManager.executeJob(mockJob);
      
      expect(result).toHaveProperty('sessions_cleaned', 2);
      expect(result).toHaveProperty('cutoff_date');
    });
    
    it('should execute delete_user_cascade task', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'delete_user_cascade',
        params: { user_id: 'user-123' },
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        started_at: null,
        completed_at: null,
        progress: null,
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] }),
        release: jest.fn(),
      };
      
      mockDb.connect.mockResolvedValue(mockClient as any);
      
      const result = await jobManager.executeJob(mockJob);
      
      expect(result).toHaveProperty('user_id', 'user-123');
      expect(result).toHaveProperty('deleted_at');
      expect(result).toHaveProperty('items_deleted', 4);
    });
    
    it('should execute sync_stripe_invoices task', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'sync_stripe_invoices',
        params: { days_back: 7 },
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        started_at: null,
        completed_at: null,
        progress: null,
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      const mockInvoices = [
        { id: 'invoice-1' },
        { id: 'invoice-2' }
      ];
      
      mockDb.query
        .mockResolvedValueOnce({ rows: mockInvoices })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await jobManager.executeJob(mockJob);
      
      expect(result).toHaveProperty('invoices_processed', 2);
      expect(result).toHaveProperty('total_invoices', 2);
    });
    
    it('should execute generate_deployment_archive task', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'generate_deployment_archive',
        params: { environment: 'production', services: ['web', 'api'] },
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        started_at: null,
        completed_at: null,
        progress: null,
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      const mockDeployments = [
        { id: 'deploy-1', environment: 'production', service_name: 'web' },
        { id: 'deploy-2', environment: 'production', service_name: 'api' }
      ];
      
      const mockArchive = {
        id: 'archive-123',
        environment: 'production',
        services: JSON.stringify(['web', 'api']),
        status: 'creating',
        created_at: new Date(),
        user_id: 'user-123'
      };
      
      mockDb.query
        .mockResolvedValueOnce({ rows: mockDeployments })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [mockArchive] });
      
      const result = await jobManager.executeJob(mockJob);
      
      expect(result).toHaveProperty('archive_id', 'archive-123');
      expect(result).toHaveProperty('environment', 'production');
      expect(result).toHaveProperty('services', ['web', 'api']);
      expect(result).toHaveProperty('deployments_count', 2);
    });
    
    it('should throw error for unknown task type', async () => {
      const mockJob = {
        id: 'test-uuid-123',
        task_type: 'unknown_task',
        params: {},
        status: JobStatus.ENQUEUED,
        created_at: new Date(),
        started_at: null,
        completed_at: null,
        progress: null,
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        next_retry_at: null,
        scheduled_at: null
      };
      
      await expect(jobManager.executeJob(mockJob)).rejects.toThrow(BackgroundJobError);
      await expect(jobManager.executeJob(mockJob)).rejects.toThrow('Unknown task type: unknown_task');
    });
  });
  
  describe('worker process', () => {
    it('should process jobs from queue', async () => {
      mockRedis.lrange.mockResolvedValue(['job-1', 'job-2']);
      mockRedis.keys.mockResolvedValue([]);
      mockRedis.pipeline.mockReturnValue({
        lrem: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
        exec: jest.fn().mockResolvedValue([])
      });
      
      await jobManager.processJobs();
      
      expect(mockRedis.lrange).toHaveBeenCalledWith('job:queue', 0, 9);
      expect(mockRedis.lrem).toHaveBeenCalledTimes(2);
    });
  });
  
  describe('API functions', () => {
    it('should export API functions', async () => {
      const { enqueueJob, getJobStatus, listJobs, cancelJob, retryJob, getJobResults, initializeJobManager } = 
        require('./background_jobs_task_queue_typescript');
      
      expect(typeof enqueueJob).toBe('function');
      expect(typeof getJobStatus).toBe('function');
      expect(typeof listJobs).toBe('function');
      expect(typeof cancelJob).toBe('function');
      expect(typeof retryJob).toBe('function');
      expect(typeof getJobResults).toBe('function');
      expect(typeof initializeJobManager).toBe('function');
    });
  });
});```typescript
import { Pool } from 'pg';
import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { format } from 'date-fns';
import { z } from 'zod';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const JobStatus = {
  ENQUEUED: 'enqueued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

type JobStatusType = typeof JobStatus[keyof typeof JobStatus];

const JobSchema = z.object({
  id: z.string().uuid(),
  task_type: z.string(),
  params: z.record(z.any()),
  status: z.enum(['enqueued', 'running', 'completed', 'failed', 'cancelled']),
  created_at: z.date(),
  started_at: z.date().nullable(),
  completed_at: z.date().nullable(),
  progress: z.string().nullable(),
  result: z.record(z.any()).nullable(),
  error: z.string().nullable(),
  retry_count: z.number().int().min(0),
  max_retries: z.number().int().min(0),
  next_retry_at: z.date().nullable(),
  scheduled_at: z.date().nullable(),
});

const JobRunSchema = z.object({
  id: z.string().uuid(),
  job_id: z.string().uuid(),
  status: z.string(),
  started_at: z.date(),
  completed_at: z.date().nullable(),
  result: z.record(z.any()).nullable(),
});

interface Job extends z.infer<typeof JobSchema> {}
interface JobRun extends z.infer<typeof JobRunSchema> {}

class BackgroundJobError extends Error {
  constructor(
    message: string,
    public jobId: string,
    public code: string
  ) {
    super(message);
    this.name = 'BackgroundJobError';
  }
}

class JobManager {
  private static instance: JobManager;
  private workerRunning = false;
  private readonly BATCH_SIZE = 10;
  private readonly RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];

  private constructor() {}

  public static getInstance(): JobManager {
    if (!JobManager.instance) {
      JobManager.instance = new JobManager();
    }
    return JobManager.instance;
  }

  public async initialize(): Promise<void> {
    await this.setupDatabase();
    await this.startWorker();
  }

  private async setupDatabase(): Promise<void> {
    await db.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id VARCHAR(255) PRIMARY KEY,
        task_type VARCHAR(255) NOT NULL,
        params JSONB NOT NULL,
        status VARCHAR(50) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        started_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE,
        progress VARCHAR(50),
        result JSONB,
        error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        next_retry_at TIMESTAMP WITH TIME ZONE,
        scheduled_at TIMESTAMP WITH TIME ZONE
      );

      CREATE TABLE IF NOT EXISTS job_runs (
        id VARCHAR(255) PRIMARY KEY,
        job_id VARCHAR(255) NOT NULL REFERENCES jobs(id),
        status VARCHAR(50) NOT NULL,
        started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP WITH TIME ZONE,
        result JSONB,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_at ON jobs(scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_next_retry_at ON jobs(next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_job_runs_job_id ON job_runs(job_id);
    `);
  }

  public async enqueueJob(
    task_type: string,
    params: Record<string, any>,
    scheduled_at?: Date,
    max_retries?: number
  ): Promise<{ success: boolean; job_id: string; status: string }> {
    const jobId = uuidv4();
    const now = new Date();
    
    const query = `
      INSERT INTO jobs (
        id, task_type, params, status, created_at, 
        scheduled_at, max_retries, retry_count, next_retry_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
    
    const values = [
      jobId,
      task_type,
      JSON.stringify(params),
      JobStatus.ENQUEUED,
      now,
      scheduled_at || null,
      max_retries || 3,
      0,
      scheduled_at && scheduled_at > now ? scheduled_at : null
    ];
    
    const result = await db.query(query, values);
    const job = result.rows[0];
    
    if (scheduled_at && scheduled_at > now) {
      await redis.setex(`job:scheduled:${jobId}`, Math.floor((scheduled_at.getTime() - now.getTime()) / 1000), jobId);
    } else {
      await redis.lpush('job:queue', jobId);
    }
    
    return { success: true, job_id: jobId, status: job.status };
  }

  public async getJobStatus(jobId: string): Promise<any> {
    const query = 'SELECT * FROM jobs WHERE id = $1';
    const result = await db.query(query, [jobId]);
    
    if (result.rows.length === 0) {
      throw new BackgroundJobError('Job not found', jobId, 'JOB_NOT_FOUND');
    }
    
    const job = result.rows[0];
    return {
      job_id: job.id,
      task_type: job.task_type,
      status: job.status,
      progress: job.progress,
      created_at: job.created_at,
      started_at: job.started_at,
      result: job.result,
      next_retry_at: job.next_retry_at
    };
  }

  public async listJobs(
    status?: string,
    task_type?: string,
    limit: number = 10
  ): Promise<{ jobs: any[]; total: number }> {
    let query = 'SELECT * FROM jobs WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;
    
    if (status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }
    
    if (task_type) {
      query += ` AND task_type = $${paramIndex++}`;
      params.push(task_type);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++}`;
    params.push(limit);
    
    const countQuery = 'SELECT COUNT(*) FROM jobs WHERE 1=1';
    const countParams: any[] = [];
    let countParamIndex = 1;
    
    if (status) {
      countQuery += ` AND status = $${countParamIndex++}`;
      countParams.push(status);
    }
    
    if (task_type) {
      countQuery += ` AND task_type = $${countParamIndex++}`;
      countParams.push(task_type);
    }
    
    const [jobsResult, countResult] = await Promise.all([
      db.query(query, params),
      db.query(countQuery, countParams)
    ]);
    
    return {
      jobs: jobsResult.rows.map(this.formatJobResponse),
      total: parseInt(countResult.rows[0].count)
    };
  }

  public async cancelJob(jobId: string): Promise<{ success: boolean; status: string }> {
    const query = `
      UPDATE jobs 
      SET status = $1, error = $2, completed_at = $3
      WHERE id = $4 AND status = $5
      RETURNING *
    `;
    
    const values = [
      JobStatus.CANCELLED,
      'Job cancelled by user',
      new Date(),
      jobId,
      JobStatus.ENQUEUED
    ];
    
    const result = await db.query(query, values);
    
    if (result.rows.length === 0) {
      throw new BackgroundJobError('Cannot cancel job', jobId, 'JOB_ALREADY_STARTED');
    }
    
    await redis.del(`job:scheduled:${jobId}`);
    await redis.lrem('job:queue', 0, jobId);
    
    return { success: true, status: JobStatus.CANCELLED };
  }

  public async retryJob(jobId: string): Promise<{ success: boolean; new_job_id: string; status: string }> {
    const query = 'SELECT * FROM jobs WHERE id = $1';
    const result = await db.query(query, [jobId]);
    
    if (result.rows.length === 0) {
      throw new BackgroundJobError('Job not found', jobId, 'JOB_NOT_FOUND');
    }
    
    const job = result.rows[0];
    
    if (job.status !== JobStatus.FAILED) {
      throw new BackgroundJobError('Can only retry failed jobs', jobId, 'INVALID_JOB_STATUS');
    }
    
    const newJobId = uuidv4();
    const now = new Date();
    
    const insertQuery = `
      INSERT INTO jobs (
        id, task_type, params, status, created_at, 
        scheduled_at, max_retries, retry_count, next_retry_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
    
    const insertValues = [
      newJobId,
      job.task_type,
      job.params,
      JobStatus.ENQUEUED,
      now,
      job.scheduled_at,
      job.max_retries,
      0,
      null
    ];
    
    const insertResult = await db.query(insertQuery, insertValues);
    await redis.lpush