using System;
using System.Collections.Generic;
using System.Data;
using System.Data.Common;
using System.Data.SQLite;
using System.Text.Json;
using System.Threading.Tasks;

namespace AuditLogging
{
    public enum ActorType
    {
        User,
        Service,
        ApiKey
    }

    public class AuditLogEntry
    {
        public string Id { get; set; }
        public DateTime Timestamp { get; set; }
        public long? ActorId { get; set; }
        public ActorType? ActorType { get; set; }
        public string Action { get; set; }
        public string ResourceType { get; set; }
        public string ResourceId { get; set; }
        public JsonElement? OldValue { get; set; }
        public JsonElement? NewValue { get; set; }
        public string WhyChainId { get; set; }
        public JsonElement? Metadata { get; set; }
    }

    public class ReplayResult
    {
        public string LogId { get; set; }
        public DateTime Timestamp { get; set; }
        public JsonElement? ResourceStateAtTime { get; set; }
        public bool HasDiverged { get; set; }
    }

    public class AuditLogRepository : IDisposable
    {
        private readonly DbConnection _connection;

        public AuditLogRepository(string connectionString)
        {
            _connection = new SQLiteConnection(connectionString);
            _connection.Open();
            CreateSchema();
        }

        private void CreateSchema()
        {
            var sql = @"
                CREATE TABLE IF NOT EXISTS audit_log (
                    id TEXT PRIMARY KEY,
                    timestamp TEXT NOT NULL,
                    actor_id INTEGER,
                    actor_type TEXT,
                    action TEXT NOT NULL,
                    resource_type TEXT NOT NULL,
                    resource_id TEXT NOT NULL,
                    old_value TEXT,
                    new_value TEXT,
                    why_chain_id TEXT,
                    metadata TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_audit_log_actor_action_resource_timestamp
                    ON audit_log(actor_id, action, resource_type, timestamp);
            ";
            using var cmd = _connection.CreateCommand();
            cmd.CommandText = sql;
            cmd.ExecuteNonQuery();
        }

        public async Task<string> LogMutationAsync(AuditLogEntry entry)
        {
            entry.Id = Guid.NewGuid().ToString();
            entry.Timestamp = DateTime.UtcNow;
            var sql = @"
                INSERT INTO audit_log
                (id, timestamp, actor_id, actor_type, action, resource_type, resource_id,
                 old_value, new_value, why_chain_id, metadata)
                VALUES
                (@id, @timestamp, @actor_id, @actor_type, @action, @resource_type, @resource_id,
                 @old_value, @new_value, @why_chain_id, @metadata);
            ";
            using var cmd = _connection.CreateCommand();
            cmd.CommandText = sql;
            cmd.Parameters.AddWithValue("@id", entry.Id);
            cmd.Parameters.AddWithValue("@timestamp", entry.Timestamp.ToString("o"));
            cmd.Parameters.AddWithValue("@actor_id", (object)entry.ActorId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("@actor_type", (object)entry.ActorType?.ToString() ?? DBNull.Value);
            cmd.Parameters.AddWithValue("@action", entry.Action);
            cmd.Parameters.AddWithValue("@resource_type", entry.ResourceType);
            cmd.Parameters.AddWithValue("@resource_id", entry.ResourceId);
            cmd.Parameters.AddWithValue("@old_value", entry.OldValue.HasValue ? entry.OldValue.Value.GetRawText() : (object)DBNull.Value);
            cmd.Parameters.AddWithValue("@new_value", entry.NewValue.HasValue ? entry.NewValue.Value.GetRawText() : (object)DBNull.Value);
            cmd.Parameters.AddWithValue("@why_chain_id", (object)entry.WhyChainId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("@metadata", entry.Metadata.HasValue ? entry.Metadata.Value.GetRawText() : (object)DBNull.Value);
            await cmd.ExecuteNonQueryAsync();
            return entry.Id;
        }

        public async Task<(IEnumerable<AuditLogEntry> Logs, int Total, bool HasMore)> QueryLogsAsync(
            long? actorId = null,
            string action = null,
            string resourceType = null,
            int limit = 100,
            int offset = 0,
            DateTime? dateFrom = null,
            DateTime? dateTo = null)
        {
            var whereClauses = new List<string>();
            var parameters = new List<SQLiteParameter>();

            if (actorId.HasValue)
            {
                whereClauses.Add("actor_id = @actor_id");
                parameters.Add(new SQLiteParameter("@actor_id", actorId.Value));
            }

            if (!string.IsNullOrEmpty(action))
            {
                var likeAction = action.Replace("*", "%");
                whereClauses.Add("action LIKE @action");
                parameters.Add(new SQLiteParameter("@action", likeAction));
            }

            if (!string.IsNullOrEmpty(resourceType))
            {
                whereClauses.Add("resource_type = @resource_type");
                parameters.Add(new SQLiteParameter("@resource_type", resourceType));
            }

            if (dateFrom.HasValue)
            {
                whereClauses.Add("timestamp >= @date_from");
                parameters.Add(new SQLiteParameter("@date_from", dateFrom.Value.ToString("o")));
            }

            if (dateTo.HasValue)
            {
                whereClauses.Add("timestamp <= @date_to");
                parameters.Add(new SQLiteParameter("@date_to", dateTo.Value.ToString("o")));
            }

            var where = whereClauses.Count > 0 ? "WHERE " + string.Join(" AND ", whereClauses) : "";

            var countSql = $"SELECT COUNT(*) FROM audit_log {where};";
            int total;
            using (var countCmd = _connection.CreateCommand())
            {
                countCmd.CommandText = countSql;
                foreach (var p in parameters) countCmd.Parameters.Add(p);
                total = Convert.ToInt32(await countCmd.ExecuteScalarAsync());
            }

            var dataSql = $@"
                SELECT * FROM audit_log
                {where}
                ORDER BY timestamp DESC
                LIMIT @limit OFFSET @offset;
            ";
            using var dataCmd = _connection.CreateCommand();
            dataCmd.CommandText = dataSql;
            foreach (var p in parameters) dataCmd.Parameters.Add(p);
            dataCmd.Parameters.AddWithValue("@limit", limit);
            dataCmd.Parameters.AddWithValue("@offset", offset);

            var logs = new List<AuditLogEntry>();
            using var reader = await dataCmd.ExecuteReaderAsync();
            while (await reader.ReadAsync())
            {
                logs.Add(ReadEntry(reader));
            }

            var hasMore = offset + limit < total;
            return (logs, total, hasMore);
        }

        public async Task<ReplayResult> ReplayAsync(string logId)
        {
            var sql = "SELECT * FROM audit_log WHERE id = @id;";
            using var cmd = _connection.CreateCommand();
            cmd.CommandText = sql;
            cmd.Parameters.AddWithValue("@id", logId);
            AuditLogEntry entry = null;
            using var reader = await cmd.ExecuteReaderAsync();
            if (await reader.ReadAsync())
            {
                entry = ReadEntry(reader);
            }
            else
            {
                throw new KeyNotFoundException($"Log with id {logId} not found.");
            }

            var divergeSql = @"
                SELECT 1 FROM audit_log
                WHERE resource_type = @resource_type
                  AND resource_id = @resource_id
                  AND timestamp > @timestamp
                LIMIT 1;
            ";
            using var divergeCmd = _connection.CreateCommand();
            divergeCmd.CommandText = divergeSql;
            divergeCmd.Parameters.AddWithValue("@resource_type", entry.ResourceType);
            divergeCmd.Parameters.AddWithValue("@resource_id", entry.ResourceId);
            divergeCmd.Parameters.AddWithValue("@timestamp", entry.Timestamp.ToString("o"));
            var diverge = await divergeCmd.ExecuteScalarAsync();
            bool hasDiverged = diverge != null;

            return new ReplayResult
            {
                LogId = entry.Id,
                Timestamp = entry.Timestamp,
                ResourceStateAtTime = entry.OldValue,
                HasDiverged = hasDiverged
            };
        }

        public async Task<IEnumerable<AuditLogEntry>> SearchAsync(string query, string resourceType = null, int limit = 50)
        {
            var sql = @"
                SELECT * FROM audit_log
                WHERE (action LIKE @q OR resource_type LIKE @q)
            ";
            if (!string.IsNullOrEmpty(resourceType))
            {
                sql += " AND resource_type = @resource_type";
            }
            sql += " ORDER BY timestamp DESC LIMIT @limit;";

            using var cmd = _connection.CreateCommand();
            cmd.CommandText = sql;
            cmd.Parameters.AddWithValue("@q", $"%{query}%");
            if (!string.IsNullOrEmpty(resourceType))
            {
                cmd.Parameters.AddWithValue("@resource_type", resourceType);
            }
            cmd.Parameters.AddWithValue("@limit", limit);

            var results = new List<AuditLogEntry>();
            using var reader = await cmd.ExecuteReaderAsync();
            while (await reader.ReadAsync())
            {
                results.Add(ReadEntry(reader));
            }
            return results;
        }

        private AuditLogEntry ReadEntry(DbDataReader reader)
        {
            var entry = new AuditLogEntry
            {
                Id = reader.GetString(reader.GetOrdinal("id")),
                Timestamp = DateTime.Parse(reader.GetString(reader.GetOrdinal("timestamp")), null, System.Globalization.DateTimeStyles.RoundtripKind),
                ActorId = reader.IsDBNull(reader.GetOrdinal("actor_id")) ? (long?)null : reader.GetInt64(reader.GetOrdinal("actor_id")),
                ActorType = reader.IsDBNull(reader.GetOrdinal("actor_type")) ? (ActorType?)null : Enum.Parse<ActorType>(reader.GetString(reader.GetOrdinal("actor_type"))),
                Action = reader.GetString(reader.GetOrdinal("action")),
                ResourceType = reader.GetString(reader.GetOrdinal("resource_type")),
                ResourceId = reader.GetString(reader.GetOrdinal("resource_id")),
                OldValue = reader.IsDBNull(reader.GetOrdinal("old_value")) ? (JsonElement?)null : JsonDocument.Parse(reader.GetString(reader.GetOrdinal("old_value"))).RootElement,
                NewValue = reader.IsDBNull(reader.GetOrdinal("new_value")) ? (JsonElement?)null : JsonDocument.Parse(reader.GetString(reader.GetOrdinal("new_value"))).RootElement,
                WhyChainId = reader.IsDBNull(reader.GetOrdinal("why_chain_id")) ? null : reader.GetString(reader.GetOrdinal("why_chain_id")),
                Metadata = reader.IsDBNull(reader.GetOrdinal("metadata")) ? (JsonElement?)null : JsonDocument.Parse(reader.GetString(reader.GetOrdinal("metadata"))).RootElement
            };
            return entry;
        }

        public void Dispose()
        {
            _connection?.Dispose();
        }
    }
}