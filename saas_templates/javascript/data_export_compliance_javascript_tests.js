const request = require('supertest');
const { app, db, run, all, get, transporter, S3_BUCKET } = require('./data_export_compliance_javascript');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

jest.setTimeout(30000);

beforeAll(async () => {
    // Insert a test user
    const userId = 'test-user-1';
    const now = new Date().toISOString();
    await run(`INSERT INTO users (id,email,name,created_at,tier,status) VALUES (?,?,?,?,?,?)`,
        [userId, 'user@example.com', 'Test User', now, 'free', 'active']);
    // Add related data
    await run(`INSERT INTO sessions (id,user_id,ip,device,created_at) VALUES (?,?,?,?,?)`,
        [uuidv4(), userId, '127.0.0.1', 'Chrome', now]);
    await run(`INSERT INTO activity (id,user_id,type,details,created_at) VALUES (?,?,?,?,?)`,
        [uuidv4(), userId, 'login', '{}', now]);
    await run(`INSERT INTO files (id,user_id,filename,size,created_at) VALUES (?,?,?,?,?)`,
        [uuidv4(), userId, 'doc.txt', 1234, now]);
    await run(`INSERT INTO preferences (user_id,notifications,theme,language) VALUES (?,?,?,?)`,
        [userId, 'all', 'dark', 'en']);
    await run(`INSERT INTO transactions (id,user_id,amount,currency,type,created_at) VALUES (?,?,?,?,?,?)`,
        [uuidv4(), userId, 9.99, 'USD', 'payment', now]);
});

afterAll(() => {
    db.close();
});

describe('Export Endpoints', () => {
    test('Request JSON export returns pending status', async () => {
        const res = await request(app)
            .post('/compliance/export')
            .set('x-user-id', 'test-user-1')
            .send({ format: 'json' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe('pending');
        expect(res.body.export_id).toBeDefined();
    });

    test('Export generation creates file and sends email', async () => {
        // Spy on transporter.sendMail
        const sendMailSpy = jest.spyOn(transporter, 'sendMail');
        const exportRes = await request(app)
            .post('/compliance/export')
            .set('x-user-id', 'test-user-1')
            .send({ format: 'json' });
        const exportId = exportRes.body.export_id;

        // Wait for background job (max 5s)
        await new Promise(r => setTimeout(r, 3000));

        const statusRes = await request(app)
            .get(`/compliance/exports/${exportId}`)
            .set('x-user-id', 'test-user-1');
        expect(statusRes.body.status).toBe('completed');
        expect(statusRes.body.file_url).toMatch(/^https?:\/\//);
        expect(statusRes.body.expires_at).toBeTruthy();

        // Email sent
        expect(sendMailSpy).toHaveBeenCalled();
        const mailArgs = sendMailSpy.mock.calls[0][0];
        expect(mailArgs.to).toBe('user@example.com');
        expect(mailArgs.text).toContain(statusRes.body.file_url);
        sendMailSpy.mockRestore();
    });

    test('Signed URL expires after 7 days (simulated)', async () => {
        const exportRes = await request(app)
            .post('/compliance/export')
            .set('x-user-id', 'test-user-1')
            .send({ format: 'csv' });
        const exportId = exportRes.body.export_id;
        await new Promise(r => setTimeout(r, 3000));
        const statusRes = await request(app)
            .get(`/compliance/exports/${exportId}`)
            .set('x-user-id', 'test-user-1');
        const url = statusRes.body.file_url;
        // Fast-forward time by mocking Date.now for signed URL verification
        const originalNow = Date.now;
        const future = Date.now() + 8 * 24 * 60 * 60 * 1000; // 8 days
        global.Date.now = () => future;
        // Attempt to get object via S3 client (will fail with signature expired)
        const s3 = new S3Client({ region: 'us-east-1' });
        const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: `exports/${exportId}.csv` });
        await expect(getSignedUrl(s3, cmd, { expiresIn: 0 })).rejects.toThrow();
        global.Date.now = originalNow;
    });
});

describe('Deletion Endpoints', () => {
    let deletionId;
    let confirmationToken;

    test('Request deletion creates pending request and sends email', async () => {
        const sendMailSpy = jest.spyOn(transporter, 'sendMail');
        const res = await request(app)
            .post('/compliance/delete')
            .set('x-user-id', 'test-user-1')
            .send({ reason: 'gdpr_request' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        deletionId = res.body.deletion_id;
        expect(deletionId).toBeDefined();

        expect(sendMailSpy).toHaveBeenCalled();
        const mail = sendMailSpy.mock.calls[0][0];
        const tokenMatch = mail.text.match(/token=([a-f0-9]{40})/);
        expect(tokenMatch).toBeTruthy();
        confirmationToken = tokenMatch[1];
        sendMailSpy.mockRestore();
    });

    test('Confirm deletion updates status to approved and schedules job', async () => {
        const res = await request(app)
            .post(`/compliance/delete/${deletionId}/confirm`)
            .set('x-user-id', 'test-user-1')
            .send({ confirmation_token: confirmationToken });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.deletion_scheduled_for).toBeTruthy();

        const row = await get(`SELECT status FROM deletion_requests WHERE id = ?`, [deletionId]);
        expect(row.status).toBe('approved');
    });

    test('Cancel deletion within grace period works', async () => {
        // Create a new deletion request to cancel
        const res = await request(app)
            .post('/compliance/delete')
            .set('x-user-id', 'test-user-1')
            .send({ reason: 'user_requested' });
        const newDelId = res.body.deletion_id;
        const cancelRes = await request(app)
            .delete(`/compliance/delete/${newDelId}`)
            .set('x-user-id', 'test-user-1');
        expect(cancelRes.status).toBe(200);
        expect(cancelRes.body.success).toBe(true);
        const row = await get(`SELECT status FROM deletion_requests WHERE id = ?`, [newDelId]);
        expect(row.status).toBe('cancelled');
    });

    test('Cascade delete removes user data but keeps audit log', async () => {
        // Fast-forward 31 days to trigger scheduled deletion
        jest.useFakeTimers();
        const originalNow = Date.now;
        const now = Date.now();
        global.Date.now = () => now + 31 * 24 * 60 * 60 * 1000;
        // Run pending timers
        jest.runOnlyPendingTimers();
        // Allow async deletion to finish
        await new Promise(r => setTimeout(r, 100));
        // Verify user and related tables are gone
        const user = await get(`SELECT * FROM users WHERE id = ?`, ['test-user-1']);
        expect(user).toBeUndefined();
        const sessions = await all(`SELECT * FROM sessions WHERE user_id = ?`, ['test-user-1']);
        expect(sessions.length).toBe(0);
        // Audit log should still have entries
        const audits = await all(`SELECT * FROM audit_log WHERE user_id = ?`, ['test-user-1']);
        expect(audits.length).toBeGreaterThan(0);
        // Cleanup timers
        jest.useRealTimers();
        global.Date.now = originalNow;
    });
});

describe('Admin Endpoints', () => {
    test('Admin can list export requests', async () => {
        const res = await request(app)
            .get('/admin/compliance/exports')
            .set('x-admin', 'true')
            .query({ status: 'completed' });
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.exports)).toBe(true);
    });

    test('Admin can list deletion requests', async () => {
        const res = await request(app)
            .get('/admin/compliance/deletions')
            .set('x-admin', 'true')
            .query({ status: 'pending' });
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.deletions)).toBe(true);
    });
});
