const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const util = require('util');

// ---------------------------------------------------------------------------
// Configuration (normally via env)
const PORT = process.env.PORT || 3000;
const S3_BUCKET = process.env.S3_BUCKET || 'compliance-exports';
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const EMAIL_FROM = process.env.EMAIL_FROM || 'no-reply@example.com';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Initialise DB (SQLite for demo)
const db = new sqlite3.Database(':memory:');
const run = util.promisify(db.run.bind(db));
const all = util.promisify(db.all.bind(db));
const get = util.promisify(db.get.bind(db));

// Execute DDL
const schema = `
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    created_at TEXT,
    tier TEXT,
    status TEXT
);
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    ip TEXT,
    device TEXT,
    created_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE activity (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    type TEXT,
    details TEXT,
    created_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE files (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    filename TEXT,
    size INTEGER,
    created_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE preferences (
    user_id TEXT PRIMARY KEY,
    notifications TEXT,
    theme TEXT,
    language TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    amount REAL,
    currency TEXT,
    type TEXT,
    created_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    action TEXT,
    details TEXT,
    created_at TEXT
);
CREATE TABLE export_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    requested_at TEXT,
    status TEXT CHECK(status IN ('pending','completed','failed')),
    format TEXT CHECK(format IN ('json','csv')),
    file_url TEXT,
    completed_at TEXT,
    expires_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE deletion_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    requested_at TEXT,
    status TEXT CHECK(status IN ('pending','approved','completed','cancelled')),
    reason TEXT,
    deleted_at TEXT,
    confirmation_token TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);
`;
db.exec(schema);

// ---------------------------------------------------------------------------
// Initialise AWS S3 client
const s3 = new S3Client({ region: S3_REGION });

// ---------------------------------------------------------------------------
// Initialise email transporter (console logger for demo)
const transporter = nodemailer.createTransport({
    streamTransport: true,
    newline: 'unix',
    buffer: true
});

// ---------------------------------------------------------------------------
// Helper functions
function audit(userId, action, details = '') {
    const id = uuidv4();
    const created_at = new Date().toISOString();
    return run(
        `INSERT INTO audit_log (id, user_id, action, details, created_at) VALUES (?,?,?,?,?)`,
        [id, userId, action, details, created_at]
    );
}

function generateConfirmationToken() {
    return crypto.randomBytes(20).toString('hex');
}

// ---------------------------------------------------------------------------
// Export generation (background job simulation)
async function generateExport(exportId) {
    try {
        const exportReq = await get(`SELECT * FROM export_requests WHERE id = ?`, [exportId]);
        if (!exportReq) throw new Error('Export request not found');

        const userId = exportReq.user_id;
        // Gather data
        const profile = await get(`SELECT id,email,name,created_at,tier,status FROM users WHERE id = ?`, [userId]);
        const sessions = await all(`SELECT ip,device,created_at FROM sessions WHERE user_id = ?`, [userId]);
        const activity = await all(`SELECT type,details,created_at FROM activity WHERE user_id = ?`, [userId]);
        const files = await all(`SELECT filename,size,created_at FROM files WHERE user_id = ?`, [userId]);
        const preferences = await get(`SELECT notifications,theme,language FROM preferences WHERE user_id = ?`, [userId]);
        const transactions = await all(`SELECT amount,currency,type,created_at FROM transactions WHERE user_id = ?`, [userId]);
        const auditTrail = await all(`SELECT action,details,created_at FROM audit_log WHERE user_id = ?`, [userId]);

        let payload;
        if (exportReq.format === 'json') {
            payload = JSON.stringify({
                profile,
                sessions,
                activity,
                files,
                preferences,
                transactions,
                auditTrail
            }, null, 2);
        } else {
            // CSV: flatten each section with a header line
            const rows = [];
            const addSection = (title, data) => {
                rows.push(`--- ${title} ---`);
                if (Array.isArray(data)) {
                    if (data.length > 0) {
                        rows.push(Object.keys(data[0]).join(','));
                        data.forEach(item => rows.push(Object.values(item).join(',')));
                    }
                } else if (data) {
                    rows.push(Object.keys(data).join(','));
                    rows.push(Object.values(data).join(','));
                }
                rows.push(''); // blank line
            };
            addSection('Profile', profile);
            addSection('Sessions', sessions);
            addSection('Activity', activity);
            addSection('Files', files);
            addSection('Preferences', preferences);
            addSection('Transactions', transactions);
            addSection('AuditTrail', auditTrail);
            payload = rows.join('\n');
        }

        const key = `exports/${exportId}.${exportReq.format}`;
        await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: key,
            Body: payload,
            ServerSideEncryption: 'AES256',
            ContentType: exportReq.format === 'json' ? 'application/json' : 'text/csv'
        }));

        const signedUrl = await getSignedUrl(s3, new GetObjectCommand({
            Bucket: S3_BUCKET,
            Key: key
        }), { expiresIn: 7 * 24 * 60 * 60 }); // 7 days

        const now = new Date().toISOString();
        const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        await run(
            `UPDATE export_requests SET status = ?, file_url = ?, completed_at = ?, expires_at = ? WHERE id = ?`,
            ['completed', signedUrl, now, expires_at, exportId]
        );

        // Send email
        const mailOptions = {
            from: EMAIL_FROM,
            to: profile.email,
            subject: 'Your data export is ready',
            text: `Your data export is ready. Download it here (valid for 7 days): ${signedUrl}`
        };
        await transporter.sendMail(mailOptions);

        await audit(userId, 'data_export_completed', `Export ${exportId} completed`);
    } catch (err) {
        console.error('Export generation error:', err);
        if (exportId) {
            await run(`UPDATE export_requests SET status = ? WHERE id = ?`, ['failed', exportId]);
        }
    }
}

// ---------------------------------------------------------------------------
// Deletion handling
async function scheduleDeletion(deletionId) {
    // In real world use a job queue; here we use setTimeout for demo (30 days)
    const deletionReq = await get(`SELECT * FROM deletion_requests WHERE id = ?`, [deletionId]);
    if (!deletionReq) return;
    const delay = 30 * 24 * 60 * 60 * 1000; // 30 days
    setTimeout(async () => {
        const latest = await get(`SELECT status FROM deletion_requests WHERE id = ?`, [deletionId]);
        if (latest.status !== 'approved') return; // cancelled or not approved
        const userId = deletionReq.user_id;

        // Cascade delete (except audit_log)
        await run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
        await run(`DELETE FROM activity WHERE user_id = ?`, [userId]);
        await run(`DELETE FROM files WHERE user_id = ?`, [userId]);
        await run(`DELETE FROM preferences WHERE user_id = ?`, [userId]);
        await run(`DELETE FROM transactions WHERE user_id = ?`, [userId]);
        await run(`DELETE FROM export_requests WHERE user_id = ?`, [userId]);
        await run(`DELETE FROM deletion_requests WHERE user_id = ? AND id != ?`, [userId, deletionId]);
        await run(`DELETE FROM users WHERE id = ?`, [userId]);

        const now = new Date().toISOString();
        await run(`UPDATE deletion_requests SET status = ?, deleted_at = ? WHERE id = ?`,
            ['completed', now, deletionId]);

        await audit(userId, 'account_deleted', `User ${userId} fully deleted`);
    }, delay);
}

// ---------------------------------------------------------------------------
// Express app & routes
const app = express();
app.use(bodyParser.json());

// Middleware to mock authentication (user_id from header)
app.use((req, res, next) => {
    const userId = req.header('x-user-id');
    if (!userId) {
        return res.status(401).json({ error: 'Missing x-user-id header' });
    }
    req.userId = userId;
    next();
});

// 1. Request data export
app.post('/compliance/export', async (req, res) => {
    const { format } = req.body;
    if (!['json', 'csv'].includes(format)) {
        return res.status(400).json({ error: 'Invalid format' });
    }
    const exportId = uuidv4();
    const now = new Date().toISOString();
    await run(
        `INSERT INTO export_requests (id, user_id, requested_at, status, format) VALUES (?,?,?,?,?)`,
        [exportId, req.userId, now, 'pending', format]
    );
    // Fire-and-forget background job
    setImmediate(() => generateExport(exportId));
    await audit(req.userId, 'data_export_requested', `Export ${exportId} requested`);
    const will_email_at = new Date(Date.now() + 5 * 1000).toISOString(); // approx
    res.json({ success: true, export_id: exportId, status: 'pending', will_email_at });
});

// 2. Check export status
app.get('/compliance/exports/:export_id', async (req, res) => {
    const exportReq = await get(`SELECT * FROM export_requests WHERE id = ? AND user_id = ?`,
        [req.params.export_id, req.userId]);
    if (!exportReq) return res.status(404).json({ error: 'Export not found' });
    res.json({
        export_id: exportReq.id,
        status: exportReq.status,
        file_url: exportReq.file_url,
        expires_at: exportReq.expires_at,
        requested_at: exportReq.requested_at
    });
});

// 3. Request account deletion
app.post('/compliance/delete', async (req, res) => {
    const { reason } = req.body;
    const allowed = ['user_requested', 'gdpr_request', 'gdpr_right_to_be_forgotten', 'other'];
    if (!allowed.includes(reason)) {
        return res.status(400).json({ error: 'Invalid reason' });
    }
    const deletionId = uuidv4();
    const token = generateConfirmationToken();
    const now = new Date().toISOString();
    await run(
        `INSERT INTO deletion_requests (id, user_id, requested_at, status, reason, confirmation_token) VALUES (?,?,?,?,?,?)`,
        [deletionId, req.userId, now, 'pending', reason, token]
    );
    await audit(req.userId, 'deletion_requested', `Reason: ${reason}`);

    // Send confirmation email
    const confirmUrl = `${BASE_URL}/compliance/delete/${deletionId}/confirm?token=${token}`;
    const mailOptions = {
        from: EMAIL_FROM,
        to: (await get(`SELECT email FROM users WHERE id = ?`, [req.userId])).email,
        subject: 'Confirm your account deletion',
        text: `Please confirm deletion by visiting: ${confirmUrl}\nYou have 30 days to cancel.`
    };
    await transporter.sendMail(mailOptions);
    const will_delete_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    res.json({ success: true, deletion_id: deletionId, status: 'pending', will_delete_at });
});

// 4. Approve/confirm deletion
app.post('/compliance/delete/:deletion_id/confirm', async (req, res) => {
    const { confirmation_token } = req.body;
    const deletionReq = await get(`SELECT * FROM deletion_requests WHERE id = ? AND user_id = ?`,
        [req.params.deletion_id, req.userId]);
    if (!deletionReq) return res.status(404).json({ error: 'Deletion request not found' });
    if (deletionReq.confirmation_token !== confirmation_token) {
        return res.status(400).json({ error: 'Invalid confirmation token' });
    }
    await run(`UPDATE deletion_requests SET status = ? WHERE id = ?`, ['approved', deletionReq.id]);
    await audit(req.userId, 'deletion_confirmed', `Deletion ${deletionReq.id} approved`);
    scheduleDeletion(deletionReq.id);
    const scheduledFor = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    res.json({ success: true, deletion_scheduled_for: scheduledFor });
});

// 5. Cancel deletion
app.delete('/compliance/delete/:deletion_id', async (req, res) => {
    const deletionReq = await get(`SELECT * FROM deletion_requests WHERE id = ? AND user_id = ?`,
        [req.params.deletion_id, req.userId]);
    if (!deletionReq) return res.status(404).json({ error: 'Deletion request not found' });
    if (deletionReq.status !== 'pending' && deletionReq.status !== 'approved') {
        return res.status(400).json({ error: 'Cannot cancel at this stage' });
    }
    await run(`UPDATE deletion_requests SET status = ? WHERE id = ?`, ['cancelled', deletionReq.id]);
    await audit(req.userId, 'deletion_cancelled', `Deletion ${deletionReq.id} cancelled`);
    res.json({ success: true, status: 'cancelled' });
});

// 6. Admin list export requests
app.get('/admin/compliance/exports', async (req, res) => {
    // Simple admin check via header
    if (req.header('x-admin') !== 'true') {
        return res.status(403).json({ error: 'Admin only' });
    }
    const { user_id, status } = req.query;
    let query = `SELECT * FROM export_requests`;
    const params = [];
    const conditions = [];
    if (user_id) {
        conditions.push(`user_id = ?`);
        params.push(user_id);
    }
    if (status) {
        conditions.push(`status = ?`);
        params.push(status);
    }
    if (conditions.length) query += ` WHERE ` + conditions.join(' AND ');
    const rows = await all(query, params);
    res.json({ exports: rows, total: rows.length });
});

// 7. Admin list deletion requests
app.get('/admin/compliance/deletions', async (req, res) => {
    if (req.header('x-admin') !== 'true') {
        return res.status(403).json({ error: 'Admin only' });
    }
    const { status } = req.query;
    let query = `SELECT * FROM deletion_requests`;
    const params = [];
    if (status) {
        query += ` WHERE status = ?`;
        params.push(status);
    }
    const rows = await all(query, params);
    res.json({ deletions: rows, total: rows.length });
});

// ---------------------------------------------------------------------------
// Server start (only if this file is executed directly)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Compliance service listening on port ${PORT}`);
    });
}

// Export for testing
module.exports = {
    app,
    db,
    run,
    all,
    get,
    generateExport,
    scheduleDeletion,
    audit,
    transporter,
    s3,
    S3_BUCKET
};