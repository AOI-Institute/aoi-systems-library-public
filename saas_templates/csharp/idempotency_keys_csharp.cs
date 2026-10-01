using System;
using System.Collections.Generic;
using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace AOI.IdempotencyKeys
{
    public interface IIdempotencyStore
    {
        bool TryClaim(string scope, string idemKey, string fingerprint, DateTime expiresAt);
        bool TryGetCompleted(string scope, string idemKey, string fingerprint, out int status, out string body);
        bool IsInProgress(string scope, string idemKey);
        void Complete(string scope, string idemKey, string fingerprint, int status, string body);
        void DeleteInProgress(string scope, string idemKey);
        void PurgeExpired(DateTime now);
    }

    public sealed class InMemoryStore : IIdempotencyStore
    {
        private sealed class Record
        {
            public string Fingerprint { get; set; }
            public string Status { get; set; }
            public int? ResponseStatus { get; set; }
            public string ResponseBody { get; set; }
            public DateTime CreatedAt { get; set; }
            public DateTime ExpiresAt { get; set; }
        }

        private readonly Dictionary<string, Record> _records = new();
        private readonly ReaderWriterLockSlim _lock = new();

        private static string Key(string scope, string idemKey) => scope + "\0" + idemKey;

        public bool TryClaim(string scope, string idemKey, string fingerprint, DateTime expiresAt)
        {
            _lock.EnterWriteLock();
            try
            {
                var key = Key(scope, idemKey);
                var now = DateTime.UtcNow;
                if (_records.TryGetValue(key, out var existing))
                {
                    if (existing.ExpiresAt <= now)
                    {
                        _records.Remove(key);
                    }
                    else
                    {
                        return false;
                    }
                }
                _records[key] = new Record
                {
                    Fingerprint = fingerprint,
                    Status = "in_progress",
                    CreatedAt = now,
                    ExpiresAt = expiresAt
                };
                return true;
            }
            finally
            {
                _lock.ExitWriteLock();
            }
        }

        public bool TryGetCompleted(string scope, string idemKey, string fingerprint, out int status, out string body)
        {
            _lock.EnterReadLock();
            try
            {
                var key = Key(scope, idemKey);
                var now = DateTime.UtcNow;
                if (_records.TryGetValue(key, out var record) &&
                    record.Status == "completed" &&
                    record.Fingerprint == fingerprint &&
                    record.ExpiresAt > now)
                {
                    status = record.ResponseStatus!.Value;
                    body = record.ResponseBody!;
                    return true;
                }
                status = 0;
                body = null;
                return false;
            }
            finally
            {
                _lock.ExitReadLock();
            }
        }

        public bool IsInProgress(string scope, string idemKey)
        {
            _lock.EnterReadLock();
            try
            {
                var key = Key(scope, idemKey);
                var now = DateTime.UtcNow;
                return _records.TryGetValue(key, out var record) &&
                       record.Status == "in_progress" &&
                       record.ExpiresAt > now;
            }
            finally
            {
                _lock.ExitReadLock();
            }
        }

        public void Complete(string scope, string idemKey, string fingerprint, int status, string body)
        {
            _lock.EnterWriteLock();
            try
            {
                var key = Key(scope, idemKey);
                if (_records.TryGetValue(key, out var record) &&
                    record.Status == "in_progress" &&
                    record.Fingerprint == fingerprint)
                {
                    record.Status = "completed";
                    record.ResponseStatus = status;
                    record.ResponseBody = body;
                }
            }
            finally
            {
                _lock.ExitWriteLock();
            }
        }

        public void DeleteInProgress(string scope, string idemKey)
        {
            _lock.EnterWriteLock();
            try
            {
                var key = Key(scope, idemKey);
                if (_records.TryGetValue(key, out var record) &&
                    record.Status == "in_progress")
                {
                    _records.Remove(key);
                }
            }
            finally
            {
                _lock.ExitWriteLock();
            }
        }

        public void PurgeExpired(DateTime now)
        {
            _lock.EnterWriteLock();
            try
            {
                var toRemove = new List<string>();
                foreach (var kvp in _records)
                {
                    if (kvp.Value.ExpiresAt <= now)
                    {
                        toRemove.Add(kvp.Key);
                    }
                }
                foreach (var key in toRemove)
                {
                    _records.Remove(key);
                }
            }
            finally
            {
                _lock.ExitWriteLock();
            }
        }
    }

    public sealed class SqlStore : IIdempotencyStore
    {
        private readonly DbConnection _connection;
        private readonly object _initLock = new();
        private bool _initialized;

        public SqlStore(DbConnection connection)
        {
            _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        }

        private void EnsureInitialized()
        {
            if (_initialized) return;
            lock (_initLock)
            {
                if (_initialized) return;
                var wasClosed = _connection.State == System.Data.ConnectionState.Closed;
                if (wasClosed) _connection.Open();
                try
                {
                    using (var cmd = _connection.CreateCommand())
                    {
                        cmd.CommandText = @"
                            CREATE TABLE IF NOT EXISTS idempotency_records (
                                scope TEXT NOT NULL,
                                idem_key TEXT NOT NULL,
                                request_fingerprint TEXT NOT NULL,
                                status TEXT NOT NULL CHECK (status IN ('in_progress','completed')),
                                response_status INTEGER NULL,
                                response_body TEXT NULL,
                                created_at TEXT NOT NULL,
                                expires_at TEXT NOT NULL,
                                PRIMARY KEY (scope, idem_key)
                            )";
                        cmd.ExecuteNonQuery();
                    }
                    _initialized = true;
                }
                finally
                {
                    if (wasClosed) _connection.Close();
                }
            }
        }

        private static string ToIso(DateTime dt) => dt.ToString("o");

        public bool TryClaim(string scope, string idemKey, string fingerprint, DateTime expiresAt)
        {
            EnsureInitialized();
            var wasClosed = _connection.State == System.Data.ConnectionState.Closed;
            if (wasClosed) _connection.Open();
            try
            {
                using (var tx = _connection.BeginTransaction())
                {
                    try
                    {
                        using (var cmd = _connection.CreateCommand())
                        {
                            cmd.Transaction = tx;
                            cmd.CommandText = @"
                                DELETE FROM idempotency_records
                                WHERE scope = @scope AND idem_key = @idem_key AND expires_at <= @now";
                            AddParam(cmd, "@scope", scope);
                            AddParam(cmd, "@idem_key", idemKey);
                            AddParam(cmd, "@now", ToIso(DateTime.UtcNow));
                            cmd.ExecuteNonQuery();
                        }

                        using (var cmd = _connection.CreateCommand())
                        {
                            cmd.Transaction = tx;
                            cmd.CommandText = @"
                                INSERT INTO idempotency_records (scope, idem_key, request_fingerprint, status, created_at, expires_at)
                                VALUES (@scope, @idem_key, @fingerprint, 'in_progress', @created, @expires)";
                            AddParam(cmd, "@scope", scope);
                            AddParam(cmd, "@idem_key", idemKey);
                            AddParam(cmd, "@fingerprint", fingerprint);
                            AddParam(cmd, "@created", ToIso(DateTime.UtcNow));
                            AddParam(cmd, "@expires", ToIso(expiresAt));
                            var rows = cmd.ExecuteNonQuery();
                            tx.Commit();
                            return rows > 0;
                        }
                    }
                    catch (DbException)
                    {
                        tx.Rollback();
                        return false;
                    }
                }
            }
            finally
            {
                if (wasClosed) _connection.Close();
            }
        }

        public bool TryGetCompleted(string scope, string idemKey, string fingerprint, out int status, out string body)
        {
            EnsureInitialized();
            var wasClosed = _connection.State == System.Data.ConnectionState.Closed;
            if (wasClosed) _connection.Open();
            try
            {
                using (var cmd = _connection.CreateCommand())
                {
                    cmd.CommandText = @"
                        SELECT response_status, response_body
                        FROM idempotency_records
                        WHERE scope = @scope AND idem_key = @idem_key
                          AND status = 'completed'
                          AND request_fingerprint = @fingerprint
                          AND expires_at > @now";
                    AddParam(cmd, "@scope", scope);
                    AddParam(cmd, "@idem_key", idemKey);
                    AddParam(cmd, "@fingerprint", fingerprint);
                    AddParam(cmd, "@now", ToIso(DateTime.UtcNow));
                    using (var reader = cmd.ExecuteReader())
                    {
                        if (reader.Read())
                        {
                            status = reader.GetInt32(0);
                            body = reader.GetString(1);
                            return true;
                        }
                    }
                }
                status = 0;
                body = null;
                return false;
            }
            finally
            {
                if (wasClosed) _connection.Close();
            }
        }

        public bool IsInProgress(string scope, string idemKey)
        {
            EnsureInitialized();
            var wasClosed = _connection.State == System.Data.ConnectionState.Closed;
            if (wasClosed) _connection.Open();
            try
            {
                using (var cmd = _connection.CreateCommand())
                {
                    cmd.CommandText = @"
                        SELECT 1 FROM idempotency_records
                        WHERE scope = @scope AND idem_key = @idem_key
                          AND status = 'in_progress'
                          AND expires_at > @now";
                    AddParam(cmd, "@scope", scope);
                    AddParam(cmd, "@idem_key", idemKey);
                    AddParam(cmd, "@now", ToIso(DateTime.UtcNow));
                    using (var reader = cmd.ExecuteReader())
                    {
                        return reader.Read();
                    }
                }
            }
            finally
            {
                if (wasClosed) _connection.Close();
            }
            return false;
        }

        public void Complete(string scope, string idemKey, string fingerprint, int status, string body)
        {
            EnsureInitialized();
            var wasClosed = _connection.State == System.Data.ConnectionState.Closed;
            if (wasClosed) _connection.Open();
            try
            {
                using (var cmd = _connection.CreateCommand())
                {
                    cmd.CommandText = @"
                        UPDATE idempotency_records
                        SET status = 'completed', response_status = @status, response_body = @body
                        WHERE scope = @scope AND idem_key = @idem_key
                          AND status = 'in_progress'
                          AND request_fingerprint = @fingerprint";
                    AddParam(cmd, "@scope", scope);
                    AddParam(cmd, "@idem_key", idemKey);
                    AddParam(cmd, "@fingerprint", fingerprint);
                    AddParam(cmd, "@status", status);
                    AddParam(cmd, "@body", body);
                    cmd.ExecuteNonQuery();
                }
            }
            finally
            {
                if (wasClosed) _connection.Close();
            }
        }

        public void DeleteInProgress(string scope, string idemKey)
        {
            EnsureInitialized();
            var wasClosed = _connection.State == System.Data.ConnectionState.Closed;
            if (wasClosed) _connection.Open();
            try
            {
                using (var cmd = _connection.CreateCommand())
                {
                    cmd.CommandText = @"
                        DELETE FROM idempotency_records
                        WHERE scope = @scope AND idem_key = @idem_key
                          AND status = 'in_progress'";
                    AddParam(cmd, "@scope", scope);
                    AddParam(cmd, "@idem_key", idemKey);
                    cmd.ExecuteNonQuery();
                }
            }
            finally
            {
                if (wasClosed) _connection.Close();
            }
        }

        public void PurgeExpired(DateTime now)
        {
            EnsureInitialized();
            var wasClosed = _connection.State == System.Data.ConnectionState.Closed;
            if (wasClosed) _connection.Open();
            try
            {
                using (var cmd = _connection.CreateCommand())
                {
                    cmd.CommandText = "DELETE FROM idempotency_records WHERE expires_at <= @now";
                    AddParam(cmd, "@now", ToIso(now));
                    cmd.ExecuteNonQuery();
                }
            }
            finally
            {
                if (wasClosed) _connection.Close();
            }
        }

        private static void AddParam(DbCommand cmd, string name, object value)
        {
            var param = cmd.CreateParameter();
            param.ParameterName = name;
            param.Value = value ?? DBNull.Value;
            cmd.Parameters.Add(param);
        }
    }

    public sealed class IdempotencyKeys
    {
        private readonly IIdempotencyStore _store;
        private readonly HashSet<string> _requiredMethods;
        private readonly TimeSpan _ttl;

        public IdempotencyKeys(IIdempotencyStore store, IEnumerable<string> requiredMethods = null, TimeSpan? ttl = null)
        {
            _store = store ?? throw new ArgumentNullException(nameof(store));
            _requiredMethods = new HashSet<string>(requiredMethods ?? new[] { "POST", "PATCH" }, StringComparer.OrdinalIgnoreCase);
            _ttl = ttl ?? TimeSpan.FromHours(24);
        }

        public bool IsRequired(string method, string path)
        {
            return _requiredMethods.Contains(method?.ToUpperInvariant());
        }

        public (int status, string contentType, string body) Handle(
            string scope,
            string idempotencyKey,
            string method,
            string path,
            string body,
            Func<(int status, string body)> operation)
        {
            if (string.IsNullOrEmpty(scope))
                throw new ArgumentException("scope required", nameof(scope));
            if (string.IsNullOrEmpty(method))
                throw new ArgumentException("method required", nameof(method));
            if (string.IsNullOrEmpty(path))
                throw new ArgumentException("path required", nameof(path));

            var fingerprint = ComputeFingerprint(method, path, body ?? "");
            var expiresAt = DateTime.UtcNow.Add(_ttl);

            if (string.IsNullOrEmpty(idempotencyKey))
            {
                if (IsRequired(method, path))
                {
                    return Problem(400, "Missing Idempotency-Key", "Idempotency-Key header is required for this operation");
                }
                var result = operation();
                return (result.status, "application/json", result.body);
            }

            if (_store.TryGetCompleted(scope, idempotencyKey, fingerprint, out var cachedStatus, out var cachedBody))
            {
                return (cachedStatus, "application/json", cachedBody);
            }

            if (_store.IsInProgress(scope, idempotencyKey))
            {
                return Problem(409, "Conflict", "Request with this Idempotency-Key is already in progress");
            }

            if (!_store.TryClaim(scope, idempotencyKey, fingerprint, expiresAt))
            {
                if (_store.TryGetCompleted(scope, idempotencyKey, fingerprint, out cachedStatus, out cachedBody))
                {
                    return (cachedStatus, "application/json", cachedBody);
                }
                return Problem(422, "Unprocessable Content", "Idempotency-Key reused with different request payload");
            }

            try
            {
                var result = operation();
                _store.Complete(scope, idempotencyKey, fingerprint, result.status, result.body);
                return (result.status, "application/json", result.body);
            }
            catch
            {
                _store.DeleteInProgress(scope, idempotencyKey);
                throw;
            }
        }

        public void PurgeExpired() => _store.PurgeExpired(DateTime.UtcNow);

        private static string ComputeFingerprint(string method, string path, string body)
        {
            using (var sha = SHA256.Create())
            {
                var input = Encoding.UTF8.GetBytes(method.ToUpperInvariant() + " " + path + "\n" + body);
                var hash = sha.ComputeHash(input);
                return Convert.ToHexString(hash).ToLowerInvariant();
            }
        }

        private static (int status, string contentType, string body) Problem(int status, string title, string detail)
        {
            var problem = new
            {
                type = "https://developer.example.com/idempotency",
                title,
                detail,
                status
            };
            var json = JsonSerializer.Serialize(problem);
            return (status, "application/problem+json", json);
        }
    }
}