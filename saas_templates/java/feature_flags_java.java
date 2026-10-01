import java.sql.*;
import java.util.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

public class FeatureFlags {
    public interface Store {
        Flag getFlag(String key);
        void setFlag(Flag flag);
        List<Audit> getAudits();
    }

    public static class Flag {
        public String key;
        public String type;
        public String defaultValue;
        public boolean enabled;
        public String rules;
        public long updatedAt;
        public String updatedBy;

        public Flag(String key, String type, String defaultValue, boolean enabled, String rules, long updatedAt, String updatedBy) {
            this.key = key;
            this.type = type;
            this.defaultValue = defaultValue;
            this.enabled = enabled;
            this.rules = rules;
            this.updatedAt = updatedAt;
            this.updatedBy = updatedBy;
        }
    }

    public static class Audit {
        public long id;
        public String flagKey;
        public String action;
        public String oldValue;
        public String newValue;
        public String actorId;
        public long at;

        public Audit(long id, String flagKey, String action, String oldValue, String newValue, String actorId, long at) {
            this.id = id;
            this.flagKey = flagKey;
            this.action = action;
            this.oldValue = oldValue;
            this.newValue = newValue;
            this.actorId = actorId;
            this.at = at;
        }
    }

    public static class InMemoryStore implements Store {
        private final Map<String, Flag> flags = new HashMap<>();
        private final List<Audit> audits = new ArrayList<>();
        private long auditId = 0;

        @Override
        public synchronized Flag getFlag(String key) {
            return flags.get(key);
        }

        @Override
        public synchronized void setFlag(Flag flag) {
            flags.put(flag.key, flag);
        }

        public synchronized void addAudit(String flagKey, String action, String oldValue, String newValue, String actorId) {
            audits.add(new Audit(++auditId, flagKey, action, oldValue, newValue, actorId, System.currentTimeMillis()));
        }

        @Override
        public synchronized List<Audit> getAudits() {
            return new ArrayList<>(audits);
        }
    }

    public static class SqlStore implements Store {
        private final String jdbcUrl;

        public SqlStore(String jdbcUrl) {
            this.jdbcUrl = jdbcUrl;
        }

        @Override
        public Flag getFlag(String key) {
            try (Connection conn = DriverManager.getConnection(jdbcUrl)) {
                PreparedStatement stmt = conn.prepareStatement("SELECT * FROM feature_flags WHERE key = ?");
                stmt.setString(1, key);
                ResultSet rs = stmt.executeQuery();
                if (rs.next()) {
                    return new Flag(
                        rs.getString("key"),
                        rs.getString("type"),
                        rs.getString("default_value"),
                        rs.getBoolean("enabled"),
                        rs.getString("rules"),
                        rs.getLong("updated_at"),
                        rs.getString("updated_by")
                    );
                }
            } catch (SQLException e) {
                // Return null on error
            }
            return null;
        }

        @Override
        public void setFlag(Flag flag) {
            try (Connection conn = DriverManager.getConnection(jdbcUrl)) {
                PreparedStatement stmt = conn.prepareStatement(
                    "INSERT OR REPLACE INTO feature_flags (key, type, default_value, enabled, rules, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
                );
                stmt.setString(1, flag.key);
                stmt.setString(2, flag.type);
                stmt.setString(3, flag.defaultValue);
                stmt.setBoolean(4, flag.enabled);
                stmt.setString(5, flag.rules);
                stmt.setLong(6, flag.updatedAt);
                stmt.setString(7, flag.updatedBy);
                stmt.executeUpdate();
            } catch (SQLException e) {
                // Silently fail
            }
        }

        @Override
        public List<Audit> getAudits() {
            List<Audit> result = new ArrayList<>();
            try (Connection conn = DriverManager.getConnection(jdbcUrl)) {
                Statement stmt = conn.createStatement();
                ResultSet rs = stmt.executeQuery("SELECT * FROM flag_audit");
                while (rs.next()) {
                    result.add(new Audit(
                        rs.getLong("id"),
                        rs.getString("flag_key"),
                        rs.getString("action"),
                        rs.getString("old_value"),
                        rs.getString("new_value"),
                        rs.getString("actor_id"),
                        rs.getLong("at")
                    ));
                }
            } catch (SQLException e) {
                // Return empty list on error
            }
            return result;
        }
    }

    private final Store store;

    public FeatureFlags(Store store) {
        this.store = store;
    }

    public static int stableHash(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hashBytes = md.digest(input.getBytes(StandardCharsets.UTF_8));
            // Take first 8 bytes as unsigned big-endian integer
            long value = 0;
            for (int i = 0; i < 8; i++) {
                value = (value << 8) | (hashBytes[i] & 0xFF);
            }
            return (int) (value % 100);
        } catch (NoSuchAlgorithmException e) {
            // Fallback to FNV-1a 32-bit
            int hash = 0x811c9dc5;
            for (byte b : input.getBytes(StandardCharsets.UTF_8)) {
                hash ^= (b & 0xFF);
                hash *= 0x01000193;
            }
            return Math.abs(hash) % 100;
        }
    }

    public static class EvaluationDetails {
        public String flagKey;
        public Object value;
        public String variant;
        public String reason;
        public String errorCode;
        public String errorMessage;

        public EvaluationDetails(String flagKey, Object value, String variant, String reason, String errorCode, String errorMessage) {
            this.flagKey = flagKey;
            this.value = value;
            this.variant = variant;
            this.reason = reason;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
        }
    }

    private EvaluationDetails evaluate(String flagKey, Object defaultValue, Map<String, Object> context, String expectedType) {
        try {
            Flag flag = store.getFlag(flagKey);
            if (flag == null) {
                return new EvaluationDetails(flagKey, defaultValue, null, "ERROR", "FLAG_NOT_FOUND", "Flag not found");
            }

            if (!flag.enabled) {
                return new EvaluationDetails(flagKey, defaultValue, null, "DISABLED", null, null);
            }

            if (!flag.type.equals(expectedType)) {
                return new EvaluationDetails(flagKey, defaultValue, null, "ERROR", "TYPE_MISMATCH", "Type mismatch");
            }

            // Parse rules
            List<Map<String, Object>> rules = parseRules(flag.rules);
            if (rules == null) {
                return new EvaluationDetails(flagKey, defaultValue, null, "ERROR", "PARSE_ERROR", "Bad rules");
            }

            String targetingKey = (String) context.get("targeting_key");
            if (targetingKey == null) {
                targetingKey = (String) context.get("user_id");
            }

            for (Map<String, Object> rule : rules) {
                List<Map<String, Object>> conditions = (List<Map<String, Object>>) rule.get("conditions");
                boolean allMatch = true;
                for (Map<String, Object> condition : conditions) {
                    String attribute = (String) condition.get("attribute");
                    String operator = (String) condition.get("operator");
                    Object value = condition.get("value");
                    Object contextValue = context.get(attribute);

                    if (!matchCondition(contextValue, operator, value)) {
                        allMatch = false;
                        break;
                    }
                }

                if (allMatch) {
                    Map<String, Object> rollout = (Map<String, Object>) rule.get("rollout");
                    if (rollout == null) {
                        // No rollout - serve value
                        return new EvaluationDetails(flagKey, rule.get("value"), (String) rule.get("variant"), "TARGETING_MATCH", null, null);
                    } else {
                        // Rollout
                        Integer percentage = (Integer) rollout.get("percentage");
                        if (targetingKey != null) {
                            int bucket = stableHash(flagKey + ":" + targetingKey);
                            if (bucket < percentage) {
                                return new EvaluationDetails(flagKey, rule.get("value"), (String) rule.get("variant"), "SPLIT", null, null);
                            }
                        }
                        // Does not apply, continue to next rule
                    }
                }
            }

            // No rule applied - return default
            return new EvaluationDetails(flagKey, parseValue(flag.defaultValue, expectedType), null, "DEFAULT", null, null);
        } catch (Exception e) {
            return new EvaluationDetails(flagKey, defaultValue, null, "ERROR", "GENERAL", e.getMessage());
        }
    }

    private boolean matchCondition(Object contextValue, String operator, Object ruleValue) {
        if (contextValue == null) {
            return false;
        }

        switch (operator) {
            case "equals":
                return contextValue.equals(ruleValue);
            case "not_equals":
                return !contextValue.equals(ruleValue);
            case "in_list":
                if (ruleValue instanceof List) {
                    return ((List<?>) ruleValue).contains(contextValue);
                }
                return false;
            case "ends_with":
                if (contextValue instanceof String && ruleValue instanceof String) {
                    return ((String) contextValue).endsWith((String) ruleValue);
                }
                return false;
            default:
                return false;
        }
    }

    private List<Map<String, Object>> parseRules(String rulesJson) {
        if (rulesJson == null || rulesJson.isEmpty()) {
            return new ArrayList<>();
        }

        try {
            // Simple JSON parser for the specific structure
            return parseJsonArray(rulesJson);
        } catch (Exception e) {
            return null;
        }
    }

    // Minimal JSON parsing for the rules structure
    private List<Map<String, Object>> parseJsonArray(String json) {
        List<Map<String, Object>> result = new ArrayList<>();
        json = json.trim();
        if (!json.startsWith("[") || !json.endsWith("]")) {
            return result;
        }

        json = json.substring(1, json.length() - 1).trim();
        if (json.isEmpty()) {
            return result;
        }

        // Split by top-level objects
        int depth = 0;
        int start = 0;
        for (int i = 0; i < json.length(); i++) {
            char c = json.charAt(i);
            if (c == '{') depth++;
            else if (c == '}') depth--;
            else if (c == ',' && depth == 0) {
                String objStr = json.substring(start, i).trim();
                if (!objStr.isEmpty()) {
                    result.add(parseJsonObject(objStr));
                }
                start = i + 1;
            }
        }

        String objStr = json.substring(start).trim();
        if (!objStr.isEmpty()) {
            result.add(parseJsonObject(objStr));
        }

        return result;
    }

    private Map<String, Object> parseJsonObject(String json) {
        Map<String, Object> result = new HashMap<>();
        json = json.trim();
        if (!json.startsWith("{") || !json.endsWith("}")) {
            return result;
        }

        json = json.substring(1, json.length() - 1).trim();
        if (json.isEmpty()) {
            return result;
        }

        // Parse key-value pairs
        int i = 0;
        while (i < json.length()) {
            // Skip whitespace
            while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
            if (i >= json.length()) break;

            // Parse key
            if (json.charAt(i) != '"') {
                i++;
                continue;
            }
            i++;
            StringBuilder key = new StringBuilder();
            while (i < json.length() && json.charAt(i) != '"') {
                key.append(json.charAt(i));
                i++;
            }
            i++; // Skip closing quote

            // Skip whitespace and colon
            while (i < json.length() && (Character.isWhitespace(json.charAt(i)) || json.charAt(i) == ':')) i++;

            // Parse value
            Object value = parseValue(json, i);
            if (value instanceof ParsedValue) {
                ParsedValue pv = (ParsedValue) value;
                result.put(key.toString(), pv.value);
                i = pv.nextIndex;
            } else {
                i++;
            }

            // Skip whitespace and comma
            while (i < json.length() && (Character.isWhitespace(json.charAt(i)) || json.charAt(i) == ',')) i++;
        }

        return result;
    }

    private static class ParsedValue {
        Object value;
        int nextIndex;

        ParsedValue(Object value, int nextIndex) {
            this.value = value;
            this.nextIndex = nextIndex;
        }
    }

    private ParsedValue parseValue(String json, int i) {
        // Skip whitespace
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        if (i >= json.length()) return new ParsedValue(null, i);

        char c = json.charAt(i);
        if (c == '"') {
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < json.length() && json.charAt(i) != '"') {
                sb.append(json.charAt(i));
                i++;
            }
            i++; // Skip closing quote
            return new ParsedValue(sb.toString(), i);
        } else if (c == '{') {
            int depth = 0;
            int start = i;
            while (i < json.length()) {
                if (json.charAt(i) == '{') depth++;
                else if (json.charAt(i) == '}') {
                    depth--;
                    if (depth == 0) {
                        i++;
                        break;
                    }
                }
                i++;
            }
            return new ParsedValue(parseJsonObject(json.substring(start, i)), i);
        } else if (c == '[') {
            int depth = 0;
            int start = i;
            while (i < json.length()) {
                if (json.charAt(i) == '[') depth++;
                else if (json.charAt(i) == ']') {
                    depth--;
                    if (depth == 0) {
                        i++;
                        break;
                    }
                }
                i++;
            }
            return new ParsedValue(parseJsonArray(json.substring(start, i)), i);
        } else if (c == 't') {
            i += 4; // true
            return new ParsedValue(true, i);
        } else if (c == 'f') {
            i += 5; // false
            return new ParsedValue(false, i);
        } else if (c == 'n') {
            i += 4; // null
            return new ParsedValue(null, i);
        } else {
            // Number
            int start = i;
            while (i < json.length() && (Character.isDigit(json.charAt(i)) || json.charAt(i) == '.' || json.charAt(i) == '-')) {
                i++;
            }
            String numStr = json.substring(start, i);
            try {
                if (numStr.contains(".")) {
                    return new ParsedValue(Double.parseDouble(numStr), i);
                } else {
                    return new ParsedValue(Integer.parseInt(numStr), i);
                }
            } catch (NumberFormatException e) {
                return new ParsedValue(null, i);
            }
        }
    }

    private Object parseValue(String value, String type) {
        if (value == null) return null;
        switch (type) {
            case "boolean":
                return Boolean.parseBoolean(value);
            case "string":
                return value;
            case "number":
                try {
                    return Double.parseDouble(value);
                } catch (NumberFormatException e) {
                    return 0;
                }
            case "object":
                return value; // Return as string representation
            default:
                return value;
        }
    }

    public boolean getBooleanValue(String flagKey, boolean defaultValue, Map<String, Object> context) {
        EvaluationDetails details = evaluate(flagKey, defaultValue, context, "boolean");
        if (details.value instanceof Boolean) {
            return (Boolean) details.value;
        }
        return defaultValue;
    }

    public String getStringValue(String flagKey, String defaultValue, Map<String, Object> context) {
        EvaluationDetails details = evaluate(flagKey, defaultValue, context, "string");
        if (details.value instanceof String) {
            return (String) details.value;
        }
        return defaultValue;
    }

    public double getNumberValue(String flagKey, double defaultValue, Map<String, Object> context) {
        EvaluationDetails details = evaluate(flagKey, defaultValue, context, "number");
        if (details.value instanceof Number) {
            return ((Number) details.value).doubleValue();
        }
        return defaultValue;
    }

    public Object getObjectValue(String flagKey, Object defaultValue, Map<String, Object> context) {
        EvaluationDetails details = evaluate(flagKey, defaultValue, context, "object");
        return details.value;
    }

    public EvaluationDetails getBooleanDetails(String flagKey, boolean defaultValue, Map<String, Object> context) {
        return evaluate(flagKey, defaultValue, context, "boolean");
    }

    public EvaluationDetails getStringDetails(String flagKey, String defaultValue, Map<String, Object> context) {
        return evaluate(flagKey, defaultValue, context, "string");
    }

    public EvaluationDetails getNumberDetails(String flagKey, double defaultValue, Map<String, Object> context) {
        return evaluate(flagKey, defaultValue, context, "number");
    }

    public EvaluationDetails getObjectDetails(String flagKey, Object defaultValue, Map<String, Object> context) {
        return evaluate(flagKey, defaultValue, context, "object");
    }

    public void setFlag(String actor, String key, String type, String defaultValue, boolean enabled, String rules) {
        Flag existing = store.getFlag(key);
        String oldValue = existing != null ? existing.defaultValue : null;
        
        Flag newFlag = new Flag(key, type, defaultValue, enabled, rules, System.currentTimeMillis(), actor);
        store.setFlag(newFlag);
        
        if (store instanceof InMemoryStore) {
            ((InMemoryStore) store).addAudit(key, "set", oldValue, defaultValue, actor);
        }
    }
}