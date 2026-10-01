const express = require('express');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');

const db = new Database(':memory:');
const app = express();
app.use(bodyParser.json());

/* ---------- DATABASE SCHEMA ---------- */
db.exec(`
CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    task_type TEXT NOT NULL,
    params TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('enqueued','running','completed','failed','cancelled')),
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    progress TEXT,
    result TEXT,
    error TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    next_retry_at TEXT,
    scheduled_at TEXT
);

CREATE TABLE job_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    result TEXT,
    FOREIGN KEY(job_id) REFERENCES jobs(id)
);
`);

/* ---------- HELPERS ---------- */
function now() {
    return new Date().toISOString();
}
function exponentialBackoff(attempt) {
    return Math.pow(2, attempt) * 1000; // milliseconds
}

/* ---------- TASK IMPLEMENTATIONS ---------- */
const TaskHandlers = {
    async send_bulk_email(job, updateProgress) {
        const params = JSON.parse(job.params);
        const total = params.total || 500; // default 500 emails
        let sent = 0, failed = 0;
        for (let i = 1; i <= total; i++) {
            // Simulate email send latency
            await new Promise(r => setTimeout(r, 5));
            // Random failure simulation (5% chance)
            if (Math.random() < 0.05) {
                failed++;
            } else {
                sent++;
            }
            updateProgress(`${i}/${total}`);
        }
        return { sent, failed, total };
    },

    async webhook_retry(job, updateProgress) {
        const params = JSON.parse(job.params);
        const attempts = params.attempts || 5;
        let successes = 0, failures = 0;
        for (let i = 1; i <= attempts; i++) {
            await new Promise(r => setTimeout(r, 10));
            if (Math.random() < 0.7) { // 70% chance success
                successes++;
            } else {
                failures++;
            }
            updateProgress(`${i}/${attempts}`);
        }
        return { successes, failures };
    },

    async export_generate(job, updateProgress) {
        const params = JSON.parse(job.params);
        const items = params.items || 1000;
        for (let i = 1; i <= items; i++) {
            await new Promise(r => setTimeout(r, 2));
            updateProgress(`${i}/${items}`);
        }
        return { exported: items };
    },

    async daily_report(job, updateProgress) {
        // Simulate aggregation steps
        const steps = 5;
        for (let i = 1; i <= steps; i++) {
            await new Promise(r => setTimeout(r, 50));
            updateProgress(`${i}/${steps}`);
        }
        return { report: 'daily_metrics', generated_at: now() };
    },

    async cleanup_old_sessions(job, updateProgress) {
        const params = JSON.parse(job.params);
        const total = params.total || 200;
        for (let i = 1; i <= total; i++) {
            await new Promise(r => setTimeout(r, 3));
            updateProgress(`${i}/${total}`);
        }
        return { cleaned: total };
    },

    async delete_user_cascade(job, updateProgress) {
        const params = JSON.parse(job.params);
        const userId = params.user_id;
        // Simulate steps
        const steps = 3;
        for (let i = 1; i <= steps; i++) {
            await new Promise(r => setTimeout(r, 30));
            updateProgress(`${i}/${steps}`);
        }
        return { deleted_user_id: userId };
    }
};

/* ---------- JOB MANAGER ---------- */
class JobManager extends EventEmitter {
    constructor(db) {
        super();
        this.db = db;
        this.startWorker();
    }

    enqueue({ task_type, params, scheduled_at, max_retries = 3 }) {
        const id = uuidv4();
        const nowStr = now();
        const stmt = this.db.prepare(`
            INSERT INTO jobs (id, task_type, params, status, created_at, max_retries, scheduled_at)
            VALUES (?, ?, ?, 'enqueued', ?, ?, ?)
        `);
        stmt.run(id, task_type, JSON.stringify(params), nowStr, max_retries, scheduled_at || null);
        return { success: true, job_id: id, status: 'enqueued' };
    }

    get(job_id) {
        const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(job_id);
        if (!row) return null;
        return {
            job_id: row.id,
            task_type: row.task_type,
            status: row.status,
            progress: row.progress,
            created_at: row.created_at,
            started_at: row.started_at,
            completed_at: row.completed_at,
            result: row.result ? JSON.parse(row.result) : null,
            error: row.error,
            next_retry_at: row.next_retry_at
        };
    }

    list({ status, task_type, limit = 10, offset = 0 }) {
        let query = `SELECT * FROM jobs`;
        const conditions = [];
        const params = [];
        if (status) {
            conditions.push(`status = ?`);
            params.push(status);
        }
        if (task_type) {
            conditions.push(`task_type = ?`);
            params.push(task_type);
        }
        if (conditions.length) query += ` WHERE ` + conditions.join(' AND ');
        query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);
        const rows = this.db.prepare(query).all(...params);
        const total = this.db.prepare(`SELECT COUNT(*) as cnt FROM jobs` + (conditions.length ? ` WHERE ` + conditions.join(' AND ') : '')).get(...params.slice(0, -2)).cnt;
        return { jobs: rows.map(r => ({
            job_id: r.id,
            task_type: r.task_type,
            status: r.status,
            progress: r.progress,
            created_at: r.created_at,
            started_at: r.started_at,
            completed_at: r.completed_at
        })), total };
    }

    cancel(job_id) {
        const job = this.db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(job_id);
        if (!job) throw new Error('Job not found');
        if (job.status !== 'enqueued') throw new Error('Only enqueued jobs can be cancelled');
        this.db.prepare(`UPDATE jobs SET status = 'cancelled', completed_at = ? WHERE id = ?`).run(now(), job_id);
        return { success: true, status: 'cancelled' };
    }

    retry(job_id) {
        const orig = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(job_id);
        if (!orig) throw new Error('Job not found');
        if (orig.status !== 'failed') throw new Error('Only failed jobs can be retried');
        const newId = uuidv4();
        const nowStr = now();
        const stmt = this.db.prepare(`
            INSERT INTO jobs (id, task_type, params, status, created_at, max_retries, scheduled_at)
            VALUES (?, ?, ?, 'enqueued', ?, ?, ?)
        `);
        stmt.run(newId, orig.task_type, orig.params, nowStr, orig.max_retries, null);
        return { success: true, new_job_id: newId, status: 'enqueued' };
    }

    getResults(job_id) {
        const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(job_id);
        if (!row) throw new Error('Job not found');
        if (row.status !== 'completed') throw new Error('Job not completed');
        return {
            job_id: row.id,
            status: row.status,
            result: row.result ? JSON.parse(row.result) : null,
            completed_at: row.completed_at
        };
    }

    startWorker() {
        setInterval(() => this.processNext(), 1000);
    }

    processNext() {
        const nowStr = now();
        const job = this.db.prepare(`
            SELECT * FROM jobs
            WHERE status = 'enqueued'
              AND (scheduled_at IS NULL OR scheduled_at <= ?)
              AND (next_retry_at IS NULL OR next_retry_at <= ?)
            ORDER BY created_at ASC
            LIMIT 1
        `).get(nowStr, nowStr);
        if (!job) return;

        // Begin transaction to claim the job
        const claim = this.db.prepare(`
            UPDATE jobs SET status = 'running', started_at = ?, progress = '0/0' WHERE id = ? AND status = 'enqueued'
        `);
        const info = claim.run(nowStr, job.id);
        if (info.changes === 0) return; // race condition, another worker claimed

        // Run the task
        (async () => {
            const updateProgress = (prog) => {
                this.db.prepare(`UPDATE jobs SET progress = ? WHERE id = ?`).run(prog, job.id);
            };
            try {
                const handler = TaskHandlers[job.task_type];
                if (!handler) throw new Error(`No handler for task_type ${job.task_type}`);
                const result = await handler(job, updateProgress);
                this.db.prepare(`
                    UPDATE jobs SET status = 'completed', completed_at = ?, result = ?, progress = ?, error = NULL
                    WHERE id = ?
                `).run(now(), JSON.stringify(result), `${result.total || Object.keys(result).length}/${result.total || Object.keys(result).length}`, job.id);
            } catch (err) {
                const retryCount = job.retry_count + 1;
                if (retryCount <= job.max_retries) {
                    const backoffMs = exponentialBackoff(retryCount);
                    const nextRetry = new Date(Date.now() + backoffMs).toISOString();
                    this.db.prepare(`
                        UPDATE jobs SET status = 'enqueued', retry_count = ?, next_retry_at = ?, error = ?, progress = NULL
                        WHERE id = ?
                    `).run(retryCount, nextRetry, err.message, job.id);
                } else {
                    this.db.prepare(`
                        UPDATE jobs SET status = 'failed', completed_at = ?, error = ?, retry_count = ?, progress = NULL
                        WHERE id = ?
                    `).run(now(), err.message, retryCount, job.id);
                }
            }
        })();
    }
}

const jobManager = new JobManager(db);

/* ---------- EXPRESS ROUTES ---------- */
app.post('/jobs/enqueue', (req, res) => {
    try {
        const { task_type, params, scheduled_at, max_retries } = req.body;
        if (!task_type || !params) throw new Error('task_type and params required');
        const result = jobManager.enqueue({ task_type, params, scheduled_at, max_retries });
        res.json(result);
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.get('/jobs/:job_id', (req, res) => {
    const job = jobManager.get(req.params.job_id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

app.get('/jobs', (req, res) => {
    const { status, task_type, limit, offset } = req.query;
    const result = jobManager.list({
        status,
        task_type,
        limit: limit ? parseInt(limit) : 10,
        offset: offset ? parseInt(offset) : 0
    });
    res.json(result);
});

app.delete('/jobs/:job_id', (req, res) => {
    try {
        const result = jobManager.cancel(req.params.job_id);
        res.json(result);
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.post('/jobs/:job_id/retry', (req, res) => {
    try {
        const result = jobManager.retry(req.params.job_id);
        res.json(result);
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.get('/jobs/:job_id/results', (req, res) => {
    try {
        const result = jobManager.getResults(req.params.job_id);
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

/* ---------- SERVER START (for manual testing) ---------- */
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Background job service listening on ${PORT}`));
}

module.exports = { app, db, jobManager };