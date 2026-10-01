const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_ALLOWED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'txt', 'csv', 'docx', 'xlsx'];
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const DEFAULT_TTL_SECONDS = 300;

const MAGIC_BYTES = {
  png: [0x89, 0x50, 0x4E, 0x47],
  jpg: [0xFF, 0xD8, 0xFF],
  jpeg: [0xFF, 0xD8, 0xFF],
  gif: [0x47, 0x49, 0x46, 0x38],
  pdf: [0x25, 0x50, 0x44, 0x46],
  docx: [0x50, 0x4B, 0x03, 0x04],
  xlsx: [0x50, 0x4B, 0x03, 0x04]
};

class InMemoryStore {
  constructor() {
    this.files = new Map();
    this.counter = 0;
  }

  nextId() {
    return (++this.counter).toString();
  }

  saveFileRecord(record) {
    this.files.set(record.id, record);
  }

  getFileRecord(id) {
    return this.files.get(id) || null;
  }

  updateFileRecord(id, updates) {
    const record = this.files.get(id);
    if (!record) return false;
    Object.assign(record, updates);
    return true;
  }

  deleteFileRecord(id) {
    return this.files.delete(id);
  }
}

class SqliteStore {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        original_name TEXT NOT NULL,
        extension TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      )
    `);
    this.insertStmt = this.db.prepare(`
      INSERT INTO files (id, org_id, owner_user_id, stored_name, original_name, extension, mime_type, size_bytes, sha256, created_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getStmt = this.db.prepare('SELECT * FROM files WHERE id = ?');
    this.updateStmt = this.db.prepare('UPDATE files SET deleted_at = ? WHERE id = ?');
  }

  nextId() {
    return crypto.randomUUID();
  }

  saveFileRecord(record) {
    this.insertStmt.run(
      record.id,
      record.org_id,
      record.owner_user_id,
      record.stored_name,
      record.original_name,
      record.extension,
      record.mime_type,
      record.size_bytes,
      record.sha256,
      record.created_at,
      record.deleted_at
    );
  }

  getFileRecord(id) {
    const row = this.getStmt.get(id);
    if (!row) return null;
    return {
      id: row.id,
      org_id: row.org_id,
      owner_user_id: row.owner_user_id,
      stored_name: row.stored_name,
      original_name: row.original_name,
      extension: row.extension,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      sha256: row.sha256,
      created_at: row.created_at,
      deleted_at: row.deleted_at
    };
  }

  updateFileRecord(id, updates) {
    if (updates.deleted_at !== undefined) {
      const result = this.updateStmt.run(updates.deleted_at, id);
      return result.changes > 0;
    }
    return false;
  }

  deleteFileRecord(id) {
    const result = this.db.prepare('DELETE FROM files WHERE id = ?').run(id);
    return result.changes > 0;
  }

  close() {
    this.db.close();
  }
}

class FileUploads {
  constructor(options = {}) {
    this.allowedExtensions = options.allowedExtensions || DEFAULT_ALLOWED_EXTENSIONS;
    this.maxFileSize = options.maxFileSize || DEFAULT_MAX_FILE_SIZE;
    this.storageDir = options.storageDir || './uploads';
    this.hmacSecret = options.hmacSecret || crypto.randomBytes(32);
    this.store = options.store || new InMemoryStore();
    this.membershipChecker = options.membershipChecker || (() => true);
  }

  sanitizeOriginalName(filename) {
    const basename = path.basename(filename);
    return basename.replace(/[\x00-\x1F\x7F]/g, '');
  }

  validateExtension(originalFilename) {
    const ext = path.extname(originalFilename).toLowerCase().slice(1);
    if (!this.allowedExtensions.includes(ext)) {
      return { valid: false, error: `Extension .${ext} not allowed` };
    }
    return { valid: true, extension: ext };
  }

  validateMagicBytes(bytes, extension) {
    if (extension === 'txt' || extension === 'csv') {
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) {
          return { valid: false, error: 'Text file contains NUL bytes' };
        }
      }
      return { valid: true };
    }

    const expected = MAGIC_BYTES[extension];
    if (!expected) {
      return { valid: true };
    }

    if (bytes.length < expected.length) {
      return { valid: false, error: 'File too small to contain magic bytes' };
    }

    for (let i = 0; i < expected.length; i++) {
      if (bytes[i] !== expected[i]) {
        return { valid: false, error: 'Magic bytes do not match extension' };
      }
    }

    return { valid: true };
  }

  upload(user, orgId, originalFilename, bytes, declaredContentType) {
    if (!this.membershipChecker(user, orgId)) {
      return { error: 'Unauthorized: user is not a member of the organization' };
    }

    const extResult = this.validateExtension(originalFilename);
    if (!extResult.valid) {
      return { error: extResult.error };
    }
    const extension = extResult.extension;

    if (bytes.length > this.maxFileSize) {
      return { error: 'File exceeds maximum allowed size' };
    }

    const magicResult = this.validateMagicBytes(bytes, extension);
    if (!magicResult.valid) {
      return { error: magicResult.error };
    }

    const fileId = this.store.nextId();
    const storedName = `${fileId}.${extension}`;
    const sanitizedOriginalName = this.sanitizeOriginalName(originalFilename);

    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    const record = {
      id: fileId,
      org_id: orgId,
      owner_user_id: user,
      stored_name: storedName,
      original_name: sanitizedOriginalName,
      extension: extension,
      mime_type: declaredContentType,
      size_bytes: bytes.length,
      sha256: sha256,
      created_at: new Date().toISOString(),
      deleted_at: null
    };

    this.store.saveFileRecord(record);

    const filePath = path.join(this.storageDir, storedName);
    fs.mkdirSync(this.storageDir, { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(bytes));

    return { file_id: fileId };
  }

  createDownloadLink(user, fileId, ttlSeconds = DEFAULT_TTL_SECONDS) {
    const record = this.store.getFileRecord(fileId);
    if (!record || record.deleted_at) {
      return { error: 'File not found' };
    }

    if (!this.membershipChecker(user, record.org_id)) {
      return { error: 'Unauthorized' };
    }

    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const data = `${fileId}:${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', this.hmacSecret)
      .update(data)
      .digest('hex');

    const token = Buffer.from(`${data}:${signature}`).toString('base64url');
    return { url: `https://example.com/download/${token}` };
  }

  download(token) {
    let decoded;
    try {
      decoded = Buffer.from(token, 'base64url').toString('utf8');
    } catch (e) {
      return { error: 'Invalid link' };
    }

    const parts = decoded.split(':');
    if (parts.length !== 3) {
      return { error: 'Invalid link' };
    }

    const [fileId, expiresAtStr, signature] = parts;
    const expiresAt = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAt)) {
      return { error: 'Invalid link' };
    }

    if (Date.now() / 1000 > expiresAt) {
      return { error: 'Link expired' };
    }

    const data = `${fileId}:${expiresAtStr}`;
    const expectedSignature = crypto
      .createHmac('sha256', this.hmacSecret)
      .update(data)
      .digest('hex');

    let sigBuf, expectedBuf;
    try {
      sigBuf = Buffer.from(signature, 'hex');
      expectedBuf = Buffer.from(expectedSignature, 'hex');
    } catch (e) {
      return { error: 'Invalid link' };
    }

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { error: 'Invalid link' };
    }

    const record = this.store.getFileRecord(fileId);
    if (!record || record.deleted_at) {
      return { error: 'File not found' };
    }

    const filePath = path.join(this.storageDir, record.stored_name);
    if (!fs.existsSync(filePath)) {
      return { error: 'File not found' };
    }

    const bytes = fs.readFileSync(filePath);
    return { bytes };
  }

  deleteFile(user, fileId) {
    const record = this.store.getFileRecord(fileId);
    if (!record || record.deleted_at) {
      return { error: 'File not found' };
    }

    if (!this.membershipChecker(user, record.org_id)) {
      return { error: 'Unauthorized' };
    }

    this.store.updateFileRecord(fileId, { deleted_at: new Date().toISOString() });
    return { success: true };
  }
}

module.exports = { FileUploads, InMemoryStore, SqliteStore };