const request = require('supertest');
const { app, db, jobManager } = require('./background_jobs_task_queue_javascript');
jest.setTimeout(30000); // allow long-running jobs

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

describe('Background Jobs & Task Queue API', () => {
    beforeAll(() => {
        // Ensure DB is clean
        db.exec('DELETE FROM jobs');
        db.exec('DELETE FROM job_runs');
    });

    test('Enqueue job, worker picks it up, status becomes running', async () => {
        const res = await request(app)
            .post('/jobs/enqueue')
            .send({ task_type: 'send_bulk_email', params: { total: 20 } });
        expect(res.body.success).toBe(true);
        const jobId = res.body.job_id;

        // Wait a moment for worker to claim
        await sleep(1500);
        const statusRes = await request(app).get(`/jobs/${jobId}`);
        expect(['running', 'completed']).toContain(statusRes.body.status);
    });

    test('Job completes, status becomes completed, results available', async () => {
        const res = await request(app)
            .post('/jobs/enqueue')
            .send({ task_type: 'export_generate', params: { items: 30 } });
        const jobId = res.body.job_id;

        // Wait enough time for completion
        await sleep(4000);
        const statusRes = await request(app).get(`/jobs/${jobId}`);
        expect(statusRes.body.status).toBe('completed');
        const resultsRes = await request(app).get(`/jobs/${jobId}/results`);
        expect(resultsRes.body.status).toBe('completed');
        expect(resultsRes.body.result).toHaveProperty('exported', 30);
    });

    test('Job fails, auto-retries with exponential backoff', async () => {
        // Create a task that throws error to trigger retry
        jobManager.db.prepare(`
            INSERT INTO jobs (id, task_type, params, status, created_at, max_retries, retry_count)
            VALUES ('fail-job', 'nonexistent_task', '{}', 'enqueued', ?, 2, 0)
        `).run(new Date().toISOString());

        // Wait for first attempt (should fail and schedule retry)
        await sleep(1500);
        let job = jobManager.get('fail-job');
        expect(job.status).toBe('enqueued');
        expect(job.retry_count).toBe(1);
        expect(job.next_retry_at).not.toBeNull();

        // Wait for backoff (2 seconds)
        await sleep(2500);
        job = jobManager.get('fail-job');
        expect(job.retry_count).toBe(2);
        expect(job.status).toBe('enqueued');

        // Wait for final retry (4 seconds)
        await sleep(4500);
        job = jobManager.get('fail-job');
        expect(job.status).toBe('failed');
        expect(job.retry_count).toBe(2);
    });

    test('Job exceeds max_retries, status becomes failed', async () => {
        // Insert job with max_retries = 1
        const id = 'max-retry-job';
        jobManager.db.prepare(`
            INSERT INTO jobs (id, task_type, params, status, created_at, max_retries, retry_count)
            VALUES (?, 'nonexistent_task', '{}', 'enqueued', ?, 1, 0)
        `).run(id, now());

        await sleep(2000);
        const job = jobManager.get(id);
        expect(job.status).toBe('failed');
        expect(job.retry_count).toBe(1);
    });

    test('User cancels before job starts, status becomes cancelled', async () => {
        const res = await request(app)
            .post('/jobs/enqueue')
            .send({ task_type: 'cleanup_old_sessions', params: { total: 10 }, scheduled_at: new Date(Date.now() + 60000).toISOString() });
        const jobId = res.body.job_id;

        const cancelRes = await request(app).delete(`/jobs/${jobId}`);
        expect(cancelRes.body.success).toBe(true);
        expect(cancelRes.body.status).toBe('cancelled');

        const statusRes = await request(app).get(`/jobs/${jobId}`);
        expect(statusRes.body.status).toBe('cancelled');
    });

    test('Progress tracking updates in real-time', async () => {
        const res = await request(app)
            .post('/jobs/enqueue')
            .send({ task_type: 'send_bulk_email', params: { total: 15 } });
        const jobId = res.body.job_id;

        // Poll progress a few times
        let progressSeen = false;
        for (let i = 0; i < 5; i++) {
            await sleep(800);
            const statusRes = await request(app).get(`/jobs/${jobId}`);
            if (statusRes.body.progress && statusRes.body.progress !== '0/0') {
                progressSeen = true;
                break;
            }
        }
        expect(progressSeen).toBe(true);
    });

    test('Scheduled jobs only run after scheduled_at time', async () => {
        const future = new Date(Date.now() + 5000).toISOString();
        const res = await request(app)
            .post('/jobs/enqueue')
            .send({ task_type: 'daily_report', params: {}, scheduled_at: future });
        const jobId = res.body.job_id;

        // Immediately check status (should be enqueued)
        let statusRes = await request(app).get(`/jobs/${jobId}`);
        expect(statusRes.body.status).toBe('enqueued');

        // Wait past scheduled time
        await sleep(6000);
        statusRes = await request(app).get(`/jobs/${jobId}`);
        expect(['running', 'completed']).toContain(statusRes.body.status);
    });

    test('Bulk job processes many items without blocking request', async () => {
        const res = await request(app)
            .post('/jobs/enqueue')
            .send({ task_type: 'send_bulk_email', params: { total: 1000 } });
        const jobId = res.body.job_id;

        // Immediately after enqueue, request should have returned
        expect(res.body.success).toBe(true);

        // Wait for completion
        await sleep(8000);
        const statusRes = await request(app).get(`/jobs/${jobId}`);
        expect(statusRes.body.status).toBe('completed');
    });

    test('Results available after completion', async () => {
        const res = await request(app)
            .post('/jobs/enqueue')
            .send({ task_type: 'send_bulk_email', params: { total: 10 } });
        const jobId = res.body.job_id;

        await sleep(3000);
        const resultsRes = await request(app).get(`/jobs/${jobId}/results`);
        expect(resultsRes.body.status).toBe('completed');
        expect(resultsRes.body.result).toHaveProperty('sent');
        expect(resultsRes.body.result).toHaveProperty('failed');
    });
});

function now() {
    return new Date().toISOString();
}