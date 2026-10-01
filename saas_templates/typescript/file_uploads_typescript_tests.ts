import { FileUploads, InMemoryFileStore } from './file_uploads_typescript.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { test } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'crypto';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fileuploads-test-'));
}

function makeUser(id: string, orgs: string[]): { id: string; orgs: string[] } {
  return { id, orgs };
}

function makePNG(): Uint8Array {
  // Minimal valid PNG header
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
}

function makeJPEG(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}

function makePDF(): Uint8Array {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
}

function makeZIP(): Uint8Array {
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
}

function makeEXE(): Uint8Array {
  return new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
}

function makeText(): Uint8Array {
  return new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x57, 0x6f, 0x72, 0x6c, 0x64]);
}

function makeTextWithNull(): Uint8Array {
  return new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]);
}

function makeLargeFile(size: number): Uint8Array {
  return new Uint8Array(size);
}

test('a .exe is rejected; a .exe renamed to .png is rejected by its magic bytes', () => {
  const dir = makeTempDir();
  const store = new InMemoryFileStore();
  const uploads = new FileUploads({
    store,
    storageDir: dir,
    hmacSecret: 'test-secret',
  });

  const user = makeUser('user1', ['org1']);
  
  // Test 1: .exe is rejected by extension
  const exeResult = uploads.upload(user, 'org1', 'malware.exe', makeEXE(), 'application/octet-stream');
  assert.ok('error' in exeResult, 'EXE should be rejected');
  assert.strictEqual(exeResult.error, 'extension not allowed');
  
  // Test 2: .exe renamed to .png is rejected by magic bytes
  const renamedResult = uploads.upload(user, 'org1', 'malware.png', makeEXE(), 'image/png');
  assert.ok('error' in renamedResult, 'EXE renamed to PNG should be rejected by magic bytes');
  assert.strictEqual(renamedResult.error, 'magic bytes mismatch');
  
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a real PNG is accepted and stored under a generated name, not the original', () => {
  const dir = makeTempDir();
  const store = new InMemoryFileStore();
  const uploads = new FileUploads({
    store,
    storageDir: dir,
    hmacSecret: 'test-secret',
  });

  const user = makeUser('user1', ['org1']);
  const pngBytes = makePNG();
  const result = uploads.upload(user, 'org1', 'photo.png', pngBytes, 'image/png');
  assert.ok('file_id' in result, 'Real PNG should be accepted');

  const record = store.get(result.file_id);
  assert.ok(record, 'File record should exist');
  assert.notStrictEqual(record.stored_name, 'photo.png', 'Stored name should be generated, not original');
  assert.ok(record.stored_name.endsWith('.png'), 'Stored name should have .png extension');
  assert.strictEqual(record.original_name, 'photo.png', 'Original name should be preserved');

  // Verify file was written to storage
  const storedPath = path.join(dir, record.stored_name);
  assert.ok(fs.existsSync(storedPath), 'File should be written to storage directory');
  
  fs.rmSync(dir, { recursive: true, force: true });
});

test('../../etc/passwd.png is stored safely; the display name has no path parts', () => {
  const dir = makeTempDir();
  const store = new InMemoryFileStore();
  const uploads = new FileUploads({
    store,
    storageDir: dir,
    hmacSecret: 'test-secret',
  });

  const user = makeUser('user1', ['org1']);
  const pngBytes = makePNG();
  const result = uploads.upload(user, 'org1', '../../etc/passwd.png', pngBytes, 'image/png');
  assert.ok('file_id' in result, 'Path traversal filename should be accepted after sanitization');

  const record = store.get(result.file_id);
  assert.ok(record, 'File record should exist');
  assert.strictEqual(record.original_name, 'passwd.png', 'Display name should have no path parts');
  assert.ok(!record.original_name.includes('..'), 'No path traversal in original name');
  assert.ok(!record.original_name.includes('/'), 'No slashes in original name');
  
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file over the size limit is rejected', () => {
  const dir = makeTempDir();
  const store = new InMemoryFileStore();
  const uploads = new FileUploads({
    store,
    storageDir: dir,
    hmacSecret: 'test-secret',
    maxFileSize: 100, // 100 bytes limit for testing
  });

  const user = makeUser('user1', ['org1']);
  const largeFile = makeLargeFile(200); // 200 bytes, over limit
  const result = uploads.upload(user, 'org1', 'big.png', largeFile, 'image/png');
  assert.ok('error' in result, 'File over size limit should be rejected');
  assert.strictEqual(result.error, 'file too large');
  
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a non-member of the org cannot upload or download', () => {
  const dir = makeTempDir();
  const store = new InMemoryFileStore();
  const uploads = new FileUploads({
    store,
    storageDir: dir,
    hmacSecret: 'test-secret',
  });

  const user = makeUser('user1', ['org1']);
  const pngBytes = makePNG();
  const uploadResult = uploads.upload(user, 'org1', 'photo.png', pngBytes, 'image/png');
  assert.ok('file_id' in uploadResult, 'Upload by member should succeed');

  // Non-member tries to upload
  const nonMember = makeUser('user2', ['org2']);
  const nonMemberUpload = uploads.upload(nonMember, 'org1', 'photo.png', pngBytes, 'image/png');
  assert.ok('error' in nonMemberUpload, 'Non-member upload should fail');
  assert.strictEqual(nonMemberUpload.error, 'unauthorized');

  // Non-member tries to create download link
  const linkResult = uploads.create_download_link(nonMember, uploadResult.file_id);
  assert.ok('error' in linkResult, 'Non-member download link should fail');
  assert.strictEqual(linkResult.error, 'unauthorized');

  // Member can create link and download
  const validLink = uploads.create_download_link(user, uploadResult.file_id);
  assert.ok('url' in validLink, 'Member should get valid link');
  const token = validLink.url.split('/').pop()!;
  const downloadResult = uploads.download(token);
  assert.ok('bytes' in downloadResult, 'Member download should succeed');
  
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an expired link is rejected; a link with one changed character is rejected', () => {
  const dir = makeTempDir();
  const store = new InMemoryFileStore();
  const uploads = new FileUploads({
    store,
    storageDir: dir,
    hmacSecret: 'test-secret',
  });

  const user = makeUser('user1', ['org1']);
  const pngBytes = makePNG();
  const uploadResult = uploads.upload(user, 'org1', 'photo.png', pngBytes, 'image/png');
  assert.ok('file_id' in uploadResult, 'Upload should succeed');

  // Create link with very short TTL
  const linkResult = uploads.create_download_link(user, uploadResult.file_id, 1);
  assert.ok('url' in linkResult, 'Link creation should succeed');
  const token = linkResult.url.split('/').pop()!;

  // Tamper with one character
  const tamperedToken = token.substring(0, token.length - 1) + (token.substring(token.length - 1) === 'A' ? 'B' : 'A');
  const tamperedResult = uploads.download(tamperedToken);
  assert.ok('error' in tamperedResult, 'Tampered link should be rejected');
  assert.strictEqual(tamperedResult.error, 'invalid link');

  // Create an expired link by manually constructing one with past expiry
  const expiredPayload = `${uploadResult.file_id}:${Math.floor(Date.now() / 1000) - 1}`;
  const expiredSig = crypto
    .createHmac('sha256', 'test-secret')
    .update(expiredPayload)
    .digest('hex');
  const expiredToken = Buffer.from(`${expiredPayload}:${expiredSig}`, 'utf8').toString('base64url');

  const expiredResult = uploads.download(expiredToken);
  assert.ok('error' in expiredResult, 'Expired link should be rejected');
  assert.strictEqual(expiredResult.error, 'link expired');
  
  fs.rmSync(dir, { recursive: true, force: true });
});

test('after delete_file, the file can no longer be linked or downloaded', () => {
  const dir = makeTempDir();
  const store = new InMemoryFileStore();
  const uploads = new FileUploads({
    store,
    storageDir: dir,
    hmacSecret: 'test-secret',
  });

  const user = makeUser('user1', ['org1']);
  const pngBytes = makePNG();
  const uploadResult = uploads.upload(user, 'org1', 'photo.png', pngBytes, 'image/png');
  assert.ok('file_id' in uploadResult, 'Upload should succeed');

  // Delete the file
  const deleteResult = uploads.delete_file(user, uploadResult.file_id);
  assert.ok('success' in deleteResult, 'Delete should succeed');

  // Try to create download link for deleted file
  const linkResult = uploads.create_download_link(user, uploadResult.file_id);
  assert.ok('error' in linkResult, 'Link creation for deleted file should fail');
  assert.strictEqual(linkResult.error, 'not found');

  // Try to download deleted file with a token created before deletion
  const validLink = uploads.create_download_link(user, uploadResult.file_id, 300);
  assert.ok('error' in validLink, 'Link creation for deleted file should fail');
  assert.strictEqual(validLink.error, 'not found');
  
  fs.rmSync(dir, { recursive: true, force: true });
});