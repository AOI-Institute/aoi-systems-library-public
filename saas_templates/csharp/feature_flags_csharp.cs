using System;
using System.Collections.Generic;
using System.Data.Common;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Security.Cryptography;

namespace AOI.FeatureFlags
{
    public interface IFeatureFlagStore
    {
        FeatureFlag GetFlag(string key);
        void SetFlag(FeatureFlag flag);
        void AddAudit(AuditEntry entry);
        List<AuditEntry> GetAudit(string flagKey);
        void Initialize();
    }

    public class FeatureFlag
    {
        public string Key { get; set; }
        public string Type { get; set; }
        public JsonElement DefaultValue { get; set; }
        public bool Enabled { get; set; }
        public string RulesJson { get; set; }
        public DateTime UpdatedAt { get; set; }
        public string UpdatedBy { get; set; }
    }

    public class Rule
    {
        public List<Condition> Conditions { get; set; }
        public string Variant { get; set; }
        public JsonElement Value { get; set; }
        public Rollout Rollout { get; set; }
    }

    public class Condition
    {
        public string Attribute { get; set; }
        public string Operator { get; set; }
        public JsonElement Value { get; set; }
    }

    public class Rollout
    {
        public int Percentage { get; set; }
    }

    public class AuditEntry
    {
        public long Id { get; set; }
        public string FlagKey { get; set; }
        public string Action { get; set; }
        public JsonElement OldValue { get; set; }
        public JsonElement NewValue { get; set; }
        public string ActorId { get; set; }
        public DateTime At { get; set; }
    }

    public class EvaluationContext
    {
        public Dictionary<string, JsonElement> Attributes { get; set; } = new Dictionary<string, JsonElement>();

        public JsonElement? GetAttribute(string name)
        {
            Attributes.TryGetValue(name, out var value);
            return value;
        }
    }

    public class EvaluationDetails<T>
    {
        public string FlagKey { get; set; }
        public T Value { get; set; }
        public string Variant { get; set; }
        public string Reason { get; set; }
        public string ErrorCode { get; set; }
        public string ErrorMessage { get; set; }
    }

    public class InMemoryFeatureFlagStore : IFeatureFlagStore
    {
        private readonly Dictionary<string, FeatureFlag> _flags = new Dictionary<string, FeatureFlag>();
        private readonly List<AuditEntry> _audit = new List<AuditEntry>();
        private readonly object _lock = new object();
        private long _auditIdCounter = 0;

        public void Initialize() { }

        public FeatureFlag GetFlag(string key)
        {
            lock (_lock)
            {
                _flags.TryGetValue(key, out var flag);
                return flag;
            }
        }

        public void SetFlag(FeatureFlag flag)
        {
            lock (_lock)
            {
                _flags[flag.Key] = flag;
            }
        }

        public void AddAudit(AuditEntry entry)
        {
            lock (_lock)
            {
                entry.Id = ++_auditIdCounter;
                _audit.Add(entry);
            }
        }

        public List<AuditEntry> GetAudit(string flagKey)
        {
            lock (_lock)
            {
                return _audit.Where(a => a.FlagKey == flagKey).ToList();
            }
        }
    }

    public class SqlFeatureFlagStore : IFeatureFlagStore
    {
        private readonly DbConnection _connection;
        private readonly object _initLock = new object();
        private bool _initialized = false;

        public SqlFeatureFlagStore(DbConnection connection)
        {
            _connection = connection;
        }

        public void Initialize()
        {
            lock (_initLock)
            {
                if (_initialized) return;
                EnsureSchema();
                _initialized = true;
            }
        }

        private void EnsureSchema()
        {
            var wasOpen = _connection.State == System.Data.ConnectionState.Open;
            if (!wasOpen) _connection.Open();
            try
            {
                using (var cmd = _connection.CreateCommand())
                {
                    cmd.CommandText = @"
                        CREATE TABLE IF NOT EXISTS feature_flags (
                            key TEXT PRIMARY KEY,
                            type TEXT NOT NULL,
                            default_value TEXT NOT NULL,
                            enabled INTEGER NOT NULL,
                            rules TEXT NOT NULL,
                            updated_at TEXT NOT NULL,
                            updated_by TEXT NOT NULL
                        );
                        CREATE TABLE IF NOT EXISTS flag_audit (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            flag_key TEXT NOT NULL,
                            action TEXT NOT NULL,
                            old_value TEXT,
                            new_value TEXT NOT NULL,
                            actor_id TEXT NOT NULL,
                            at TEXT NOT NULL
                        );";
                    cmd.ExecuteNonQuery();
                }
            }
            finally
            {
                if (!wasOpen) _connection.Close();
            }
        }

        public FeatureFlag GetFlag(string key)
        {
            Initialize();
            var wasOpen = _connection.State == System.Data.ConnectionState.Open;
            if (!wasOpen) _connection.Open();
            try
            {
                using (var cmd = _connection.CreateCommand())
                {
                    cmd.CommandText = "SELECT key, type, default_value, enabled, rules, updated_at, updated_by FROM feature_flags WHERE key = @key";
                    var p = cmd.CreateParameter();
                    p.ParameterName = "@key";
                    p.Value = key;
                    cmd.Parameters.Add(p);
                    using (var reader = cmd.ExecuteReader())
                    {
                        if (!reader.Read()) return null;
                        return new FeatureFlag
                        {
                            Key = reader.GetString(0),
                            Type = reader.GetString(1),
                            DefaultValue = JsonDocument.Parse(reader.GetString(2)).RootElement,
                            Enabled = reader.GetInt32(3) == 1,
                            RulesJson = reader.GetString(4),
                            UpdatedAt = DateTime.Parse(reader.GetString(5)),
                            UpdatedBy = reader.GetString(6)
                        };
                    }
                }
            }
            finally
            {
                if (!wasOpen) _connection.Close();
            }
        }

        public void SetFlag(FeatureFlag flag)
        {
            Initialize();
            var wasOpen = _connection.State == System.Data.ConnectionState.Open;
            if (!wasOpen) _connection.Open();
            try
            {
                using (var cmd = _connection.CreateCommand())
                {
                    cmd.CommandText = @"
                        INSERT OR REPLACE INTO feature_flags (key, type, default_value, enabled, rules, updated_at, updated_by)
                        VALUES (@key, @type, @default_value, @enabled, @rules, @updated_at, @updated_by)";
                    AddParam(cmd, "@key", flag.Key);
                    AddParam(cmd, "@type", flag.Type);
                    AddParam(cmd, "@default_value", flag.DefaultValue.GetRawText());
                    AddParam(cmd, "@enabled", flag.Enabled ? 1 : 0);
                    AddParam(cmd, "@rules", flag.RulesJson);
                    AddParam(cmd, "@updated_at", flag.UpdatedAt.ToString("o"));
                    AddParam(cmd, "@updated_by", flag.UpdatedBy);
                    cmd.ExecuteNonQuery();
                }
            }
            finally
            {
                if (!wasOpen) _connection.Close();
            }
        }

        public void AddAudit(AuditEntry entry)
        {
            Initialize();
            var wasOpen = _connection.State == System.Data.ConnectionState.Open;
            if (!wasOpen) _connection.Open();
            try
            {
                using (var cmd = _connection.CreateCommand())
                {
                    cmd.CommandText = @"
                        INSERT INTO flag_audit (flag_key, action, old_value, new_value, actor_id, at)
                        VALUES (@flag_key, @action, @old_value, @new_value, @actor_id, @at)";
                    AddParam(cmd, "@flag_key", entry.FlagKey);
                    AddParam(cmd, "@action", entry.Action);
                    AddParam(cmd, "@old_value", entry.OldValue.ValueKind == JsonValueKind.Undefined ? null : entry.OldValue.GetRawText());
                    AddParam(cmd, "@new_value", entry.NewValue.GetRawText());
                    AddParam(cmd, "@actor_id", entry.ActorId);
                    AddParam(cmd, "@at", entry.At.ToString("o"));
                    cmd.ExecuteNonQuery();
                }
            }
            finally
            {
                if (!wasOpen) _connection.Close();
            }
        }

        public List<AuditEntry> GetAudit(string flagKey)
        {
            Initialize();
            var wasOpen = _connection.State == System.Data.ConnectionState.Open;
            if (!wasOpen) _connection.Open();
            try
            {
                var list = new List<AuditEntry>();
                using (var cmd = _connection.CreateCommand())
                {
                    cmd.CommandText = "SELECT id, flag_key, action, old_value, new_value, actor_id, at FROM flag_audit WHERE flag_key = @flag_key ORDER BY id";
                    var p = cmd.CreateParameter();
                    p.ParameterName = "@flag_key";
                    p.Value = flagKey;
                    cmd.Parameters.Add(p);
                    using (var reader = cmd.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            list.Add(new AuditEntry
                            {
                                Id = reader.GetInt64(0),
                                FlagKey = reader.GetString(1),
                                Action = reader.GetString(2),
                                OldValue = reader.IsDBNull(3) ? default : JsonDocument.Parse(reader.GetString(3)).RootElement,
                                NewValue = JsonDocument.Parse(reader.GetString(4)).RootElement,
                                ActorId = reader.GetString(5),
                                At = DateTime.Parse(reader.GetString(6))
                            });
                        }
                    }
                }
                return list;
            }
            finally
            {
                if (!wasOpen) _connection.Close();
            }
        }

        private void AddParam(DbCommand cmd, string name, object value)
        {
            var p = cmd.CreateParameter();
            p.ParameterName = name;
            p.Value = value ?? DBNull.Value;
            cmd.Parameters.Add(p);
        }
    }

    public class FeatureFlagClient
    {
        private readonly IFeatureFlagStore _store;
        private readonly JsonSerializerOptions _jsonOptions = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        };

        public FeatureFlagClient(IFeatureFlagStore store)
        {
            _store = store;
        }

        public bool GetBooleanValue(string flagKey, bool defaultValue, EvaluationContext context = null)
        {
            return GetBooleanDetails(flagKey, defaultValue, context).Value;
        }

        public string GetStringValue(string flagKey, string defaultValue, EvaluationContext context = null)
        {
            return GetStringDetails(flagKey, defaultValue, context).Value;
        }

        public double GetNumberValue(string flagKey, double defaultValue, EvaluationContext context = null)
        {
            return GetNumberDetails(flagKey, defaultValue, context).Value;
        }

        public JsonElement GetObjectValue(string flagKey, JsonElement defaultValue, EvaluationContext context = null)
        {
            return GetObjectDetails(flagKey, defaultValue, context).Value;
        }

        public EvaluationDetails<bool> GetBooleanDetails(string flagKey, bool defaultValue, EvaluationContext context = null)
        {
            return Evaluate<bool>(flagKey, defaultValue, context, "boolean", v => v.GetBoolean());
        }

        public EvaluationDetails<string> GetStringDetails(string flagKey, string defaultValue, EvaluationContext context = null)
        {
            return Evaluate<string>(flagKey, defaultValue, context, "string", v => v.GetString());
        }

        public EvaluationDetails<double> GetNumberDetails(string flagKey, double defaultValue, EvaluationContext context = null)
        {
            return Evaluate<double>(flagKey, defaultValue, context, "number", v => v.GetDouble());
        }

        public EvaluationDetails<JsonElement> GetObjectDetails(string flagKey, JsonElement defaultValue, EvaluationContext context = null)
        {
            return Evaluate<JsonElement>(flagKey, defaultValue, context, "object", v => v);
        }

        private EvaluationDetails<T> Evaluate<T>(string flagKey, T defaultValue, EvaluationContext context, string expectedType, Func<JsonElement, T> converter)
        {
            try
            {
                var flag = _store.GetFlag(flagKey);
                if (flag == null)
                {
                    return ErrorResult(flagKey, defaultValue, "FLAG_NOT_FOUND", $"Flag '{flagKey}' not found");
                }

                if (!flag.Enabled)
                {
                    return new EvaluationDetails<T>
                    {
                        FlagKey = flagKey,
                        Value = defaultValue,
                        Variant = null,
                        Reason = "DISABLED",
                        ErrorCode = null,
                        ErrorMessage = null
                    };
                }

                if (flag.Type != expectedType)
                {
                    return ErrorResult(flagKey, defaultValue, "TYPE_MISMATCH", $"Flag '{flagKey}' is of type '{flag.Type}', not '{expectedType}'");
                }

                List<Rule> rules = null;
                if (!string.IsNullOrEmpty(flag.RulesJson))
                {
                    try
                    {
                        rules = JsonSerializer.Deserialize<List<Rule>>(flag.RulesJson, _jsonOptions);
                    }
                    catch (JsonException)
                    {
                        return ErrorResult(flagKey, defaultValue, "PARSE_ERROR", $"Failed to parse rules JSON for flag '{flagKey}'");
                    }
                }
                else
                {
                    rules = new List<Rule>();
                }

                if (rules != null)
                {
                    foreach (var rule in rules)
                    {
                        if (MatchesConditions(rule.Conditions, context))
                        {
                            if (rule.Rollout != null && rule.Rollout.Percentage > 0)
                            {
                                var targetingKey = context?.GetAttribute("targeting_key")?.GetString() ?? "";
                                var bucket = GetBucket(flagKey, targetingKey);
                                if (bucket < rule.Rollout.Percentage)
                                {
                                    return CreateResult(flagKey, rule, "SPLIT", defaultValue, converter);
                                }
                                continue;
                            }
                            return CreateResult(flagKey, rule, "TARGETING_MATCH", defaultValue, converter);
                        }
                    }
                }

                return new EvaluationDetails<T>
                {
                    FlagKey = flagKey,
                    Value = defaultValue,
                    Variant = null,
                    Reason = "DEFAULT",
                    ErrorCode = null,
                    ErrorMessage = null
                };
            }
            catch (Exception ex)
            {
                return ErrorResult(flagKey, defaultValue, "GENERAL", ex.Message);
            }
        }

        private bool MatchesConditions(List<Condition> conditions, EvaluationContext context)
        {
            if (conditions == null || conditions.Count == 0) return true;
            if (context == null) return false;

            foreach (var condition in conditions)
            {
                var attrValue = context.GetAttribute(condition.Attribute);
                if (!attrValue.HasValue || !MatchCondition(attrValue.Value, condition.Operator, condition.Value))
                {
                    return false;
                }
            }
            return true;
        }

        private bool MatchCondition(JsonElement attrValue, string op, JsonElement expectedValue)
        {
            switch (op)
            {
                case "equals":
                    return JsonElementEquals(attrValue, expectedValue);
                case "not_equals":
                    return !JsonElementEquals(attrValue, expectedValue);
                case "in_list":
                    if (expectedValue.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in expectedValue.EnumerateArray())
                        {
                            if (JsonElementEquals(attrValue, item)) return true;
                        }
                    }
                    return false;
                case "ends_with":
                    if (attrValue.ValueKind == JsonValueKind.String && expectedValue.ValueKind == JsonValueKind.String)
                    {
                        return attrValue.GetString().EndsWith(expectedValue.GetString());
                    }
                    return false;
                default:
                    return false;
            }
        }

        private bool JsonElementEquals(JsonElement a, JsonElement b)
        {
            if (a.ValueKind != b.ValueKind) return false;
            switch (a.ValueKind)
            {
                case JsonValueKind.String: return a.GetString() == b.GetString();
                case JsonValueKind.Number: return a.GetDouble() == b.GetDouble();
                case JsonValueKind.True: return b.ValueKind == JsonValueKind.True;
                case JsonValueKind.False: return b.ValueKind == JsonValueKind.False;
                case JsonValueKind.Null: return b.ValueKind == JsonValueKind.Null;
                default: return a.GetRawText() == b.GetRawText();
            }
        }

        private int GetBucket(string flagKey, string targetingKey)
        {
            var input = flagKey + ":" + targetingKey;
            // FNV-1a 32-bit hash
            const uint fnv_offset_basis = 2166136261u;
            const uint fnv_prime = 16777619u;
            uint hash = fnv_offset_basis;
            foreach (byte b in Encoding.UTF8.GetBytes(input))
            {
                hash ^= b;
                hash *= fnv_prime;
            }
            return (int)(hash % 100);
        }

        private EvaluationDetails<T> CreateResult<T>(string flagKey, Rule rule, string reason, T defaultValue, Func<JsonElement, T> converter)
        {
            try
            {
                var value = converter(rule.Value);
                return new EvaluationDetails<T>
                {
                    FlagKey = flagKey,
                    Value = value,
                    Variant = rule.Variant,
                    Reason = reason,
                    ErrorCode = null,
                    ErrorMessage = null
                };
            }
            catch
            {
                return ErrorResult(flagKey, defaultValue, "TYPE_MISMATCH", $"Rule value type mismatch for flag '{flagKey}'");
            }
        }

        private EvaluationDetails<T> ErrorResult<T>(string flagKey, T defaultValue, string errorCode, string errorMessage)
        {
            return new EvaluationDetails<T>
            {
                FlagKey = flagKey,
                Value = defaultValue,
                Variant = null,
                Reason = "ERROR",
                ErrorCode = errorCode,
                ErrorMessage = errorMessage
            };
        }

        public void SetFlag(string actor, string key, string type, JsonElement defaultValue, bool enabled, string rulesJson)
        {
            var oldFlag = _store.GetFlag(key);
            JsonElement oldValue;
            if (oldFlag != null)
            {
                var oldObj = new
                {
                    oldFlag.Type,
                    DefaultValue = oldFlag.DefaultValue,
                    oldFlag.Enabled,
                    RulesJson = oldFlag.RulesJson
                };
                oldValue = JsonDocument.Parse(JsonSerializer.Serialize(oldObj)).RootElement;
            }
            else
            {
                oldValue = default;
            }

            var flag = new FeatureFlag
            {
                Key = key,
                Type = type,
                DefaultValue = defaultValue,
                Enabled = enabled,
                RulesJson = rulesJson,
                UpdatedAt = DateTime.UtcNow,
                UpdatedBy = actor
            };

            _store.SetFlag(flag);

            var newObj = new
            {
                flag.Type,
                flag.DefaultValue,
                flag.Enabled,
                flag.RulesJson
            };
            var newValue = JsonDocument.Parse(JsonSerializer.Serialize(newObj)).RootElement;

            _store.AddAudit(new AuditEntry
            {
                FlagKey = key,
                Action = oldFlag == null ? "CREATE" : "UPDATE",
                OldValue = oldValue,
                NewValue = newValue,
                ActorId = actor,
                At = DateTime.UtcNow
            });
        }
    }
}