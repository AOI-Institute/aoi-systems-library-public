<?php

namespace Aoi\FeatureFlags;

final class FeatureFlagOptions {
    public readonly ?\Closure $clock;
    public function __construct(?\Closure $clock = null) {
        $this->clock = $clock;
    }
}

final class FeatureFlagError extends \RuntimeException {
    public readonly string $error_code;
    public readonly int $status;
    public function __construct(string $error_code, int $status, string $message) {
        parent::__construct($message, 0, null);
        $this->error_code = $error_code;
        $this->status = $status;
    }
}

final class FlagRecord {
    public readonly string $key;
    public readonly string $type;
    public readonly string $default_value_json;
    public readonly bool $enabled;
    public readonly string $rules_json;
    public readonly int $updated_at;
    public readonly string $updated_by;
    public function __construct(string $key, string $type, string $default_value_json, bool $enabled, string $rules_json, int $updated_at, string $updated_by) {
        $this->key = $key;
        $this->type = $type;
        $this->default_value_json = $default_value_json;
        $this->enabled = $enabled;
        $this->rules_json = $rules_json;
        $this->updated_at = $updated_at;
        $this->updated_by = $updated_by;
    }
}

final class AuditEntry {
    public readonly int $id;
    public readonly string $flag_key;
    public readonly string $action;
    public readonly ?string $old_value;
    public readonly string $new_value;
    public readonly string $actor_id;
    public readonly int $at;
    public function __construct(int $id, string $flag_key, string $action, ?string $old_value, string $new_value, string $actor_id, int $at) {
        $this->id = $id;
        $this->flag_key = $flag_key;
        $this->action = $action;
        $this->old_value = $old_value;
        $this->new_value = $new_value;
        $this->actor_id = $actor_id;
        $this->at = $at;
    }
}

final class EvaluationDetails {
    public readonly string $flag_key;
    public readonly mixed $value;
    public readonly ?string $variant;
    public readonly string $reason;
    public readonly ?string $error_code;
    public readonly ?string $error_message;
    public function __construct(string $flag_key, mixed $value, ?string $variant, string $reason, ?string $error_code, ?string $error_message) {
        $this->flag_key = $flag_key;
        $this->value = $value;
        $this->variant = $variant;
        $this->reason = $reason;
        $this->error_code = $error_code;
        $this->error_message = $error_message;
    }
}

interface FlagStore {
    public function get_flag(string $key): ?FlagRecord;
    public function put_flag(FlagRecord $record): void;
    public function save_flag_audited(FlagRecord $record, string $actor_id, int $at): AuditEntry;
    public function list_audit(string $flag_key): array;
}

final class InMemoryFlagStore implements FlagStore {
    private array $flags = [];
    private array $audit = [];
    private int $next_id = 1;

    public function get_flag(string $key): ?FlagRecord {
        return $this->flags[$key] ?? null;
    }

    public function put_flag(FlagRecord $record): void {
        $this->flags[$record->key] = $record;
    }

    public function save_flag_audited(FlagRecord $record, string $actor_id, int $at): AuditEntry {
        $previous = $this->flags[$record->key] ?? null;
        $old_value = $previous ? self::snapshot($previous) : null;
        $new_value = self::snapshot($record);
        $action = $previous ? 'update' : 'create';
        $entry = new AuditEntry($this->next_id++, $record->key, $action, $old_value, $new_value, $actor_id, $at);
        $this->flags[$record->key] = $record;
        $this->audit[] = $entry;
        return $entry;
    }

    public function list_audit(string $flag_key): array {
        $result = [];
        foreach ($this->audit as $entry) {
            if ($entry->flag_key === $flag_key) {
                $result[] = $entry;
            }
        }
        return $result;
    }

    public static function snapshot(FlagRecord $record): string {
        return '{"type":' . json_encode($record->type) . ',"default_value":' . $record->default_value_json . ',"enabled":' . ($record->enabled ? 'true' : 'false') . ',"rules":' . $record->rules_json . '}';
    }
}

final class SqlFlagStore implements FlagStore {
    public const SCHEMA_STATEMENTS = [
        "CREATE TABLE IF NOT EXISTS feature_flags (key TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('boolean','string','number','object')), default_value TEXT NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), rules TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS flag_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, flag_key TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('create','update')), old_value TEXT, new_value TEXT NOT NULL, actor_id TEXT NOT NULL, at INTEGER NOT NULL)",
        "CREATE INDEX IF NOT EXISTS flag_audit_by_key ON flag_audit (flag_key, id)"
    ];

    private \PDO $pdo;

    public function __construct(\PDO $pdo) {
        $this->pdo = $pdo;
        foreach (self::SCHEMA_STATEMENTS as $stmt) {
            $this->pdo->exec($stmt);
        }
    }

    public function get_flag(string $key): ?FlagRecord {
        $stmt = $this->pdo->prepare('SELECT key, type, default_value, enabled, rules, updated_at, updated_by FROM feature_flags WHERE key = ?');
        $stmt->execute([$key]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        if (!$row) return null;
        return new FlagRecord($row['key'], $row['type'], $row['default_value'], (bool)$row['enabled'], $row['rules'], (int)$row['updated_at'], $row['updated_by']);
    }

    public function put_flag(FlagRecord $record): void {
        $stmt = $this->pdo->prepare('INSERT INTO feature_flags (key, type, default_value, enabled, rules, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET type=excluded.type, default_value=excluded.default_value, enabled=excluded.enabled, rules=excluded.rules, updated_at=excluded.updated_at, updated_by=excluded.updated_by');
        $stmt->execute([$record->key, $record->type, $record->default_value_json, $record->enabled ? 1 : 0, $record->rules_json, $record->updated_at, $record->updated_by]);
    }

    public function save_flag_audited(FlagRecord $record, string $actor_id, int $at): AuditEntry {
        $this->pdo->beginTransaction();
        try {
            $previous = $this->get_flag($record->key);
            $old_value = $previous ? InMemoryFlagStore::snapshot($previous) : null;
            $new_value = InMemoryFlagStore::snapshot($record);
            $action = $previous ? 'update' : 'create';

            $this->put_flag($record);

            $stmt = $this->pdo->prepare('INSERT INTO flag_audit (flag_key, action, old_value, new_value, actor_id, at) VALUES (?, ?, ?, ?, ?, ?)');
            $stmt->execute([$record->key, $action, $old_value, $new_value, $actor_id, $at]);
            $id = (int)$this->pdo->lastInsertId();

            $this->pdo->commit();
            return new AuditEntry($id, $record->key, $action, $old_value, $new_value, $actor_id, $at);
        } catch (\Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
    }

    public function list_audit(string $flag_key): array {
        $stmt = $this->pdo->prepare('SELECT id, flag_key, action, old_value, new_value, actor_id, at FROM flag_audit WHERE flag_key = ? ORDER BY id ASC');
        $stmt->execute([$flag_key]);
        $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC);
        $result = [];
        foreach ($rows as $row) {
            $result[] = new AuditEntry((int)$row['id'], $row['flag_key'], $row['action'], $row['old_value'] !== null ? $row['old_value'] : null, $row['new_value'], $row['actor_id'], (int)$row['at']);
        }
        return $result;
    }
}

final class FeatureFlagClient {
    private FlagStore $store;
    private ?\Closure $clock;

    public function __construct(FlagStore $store, ?FeatureFlagOptions $options = null) {
        $this->store = $store;
        $this->clock = $options?->clock ?? fn() => time();
    }

    public static function stable_bucket(string $flag_key, string $targeting_key): int {
        $input = $flag_key . ':' . $targeting_key;
        $hash_bytes = hash('sha256', $input, true);
        $bucket = 0;
        for ($i = 0; $i < 8; $i++) {
            $bucket = ($bucket * 256 + ord($hash_bytes[$i])) % 100;
        }
        return $bucket;
    }

    public function get_boolean_value(string $flag_key, bool $default_value, ?array $context = null): bool {
        return $this->get_boolean_details($flag_key, $default_value, $context)->value;
    }

    public function get_string_value(string $flag_key, string $default_value, ?array $context = null): string {
        return $this->get_string_details($flag_key, $default_value, $context)->value;
    }

    public function get_number_value(string $flag_key, int|float $default_value, ?array $context = null): int|float {
        return $this->get_number_details($flag_key, $default_value, $context)->value;
    }

    public function get_object_value(string $flag_key, array $default_value, ?array $context = null): array {
        return $this->get_object_details($flag_key, $default_value, $context)->value;
    }

    public function get_boolean_details(string $flag_key, bool $default_value, ?array $context = null): EvaluationDetails {
        return $this->evaluate($flag_key, 'boolean', $default_value, $context);
    }

    public function get_string_details(string $flag_key, string $default_value, ?array $context = null): EvaluationDetails {
        return $this->evaluate($flag_key, 'string', $default_value, $context);
    }

    public function get_number_details(string $flag_key, int|float $default_value, ?array $context = null): EvaluationDetails {
        return $this->evaluate($flag_key, 'number', $default_value, $context);
    }

    public function get_object_details(string $flag_key, array $default_value, ?array $context = null): EvaluationDetails {
        return $this->evaluate($flag_key, 'object', $default_value, $context);
    }

    public function set_flag(string $actor_id, string $key, string $flag_type, string $default_value_json, bool $enabled, string $rules_json): AuditEntry {
        if ($actor_id === '') {
            throw new FeatureFlagError('INVALID_ACTOR', 400, 'actor_id must be non-empty');
        }
        if (!preg_match('/^[A-Za-z0-9_.-]{1,128}$/', $key)) {
            throw new FeatureFlagError('INVALID_KEY', 400, 'key must be 1-128 chars [A-Za-z0-9_.-]');
        }
        if (!in_array($flag_type, ['boolean', 'string', 'number', 'object'], true)) {
            throw new FeatureFlagError('INVALID_TYPE', 400, 'flag_type must be one of boolean, string, number, object');
        }
        if (!is_bool($enabled)) {
            throw new FeatureFlagError('INVALID_ENABLED', 400, 'enabled must be a boolean');
        }

        try {
            $default_parsed = $this->parse_json_strict($default_value_json);
        } catch (\JsonException $e) {
            throw new FeatureFlagError('INVALID_DEFAULT_VALUE', 400, 'default_value is not valid JSON');
        }
        if (!$this->kind_matches($default_parsed, $flag_type)) {
            throw new FeatureFlagError('INVALID_DEFAULT_VALUE', 400, 'default_value kind does not match flag_type');
        }

        try {
            $rules = $this->parse_rules($rules_json);
        } catch (\JsonException $e) {
            throw new FeatureFlagError('INVALID_RULES', 400, 'rules is not valid JSON');
        }
        foreach ($rules as $rule) {
            if (!$this->kind_matches($rule['value'], $flag_type)) {
                throw new FeatureFlagError('INVALID_RULES', 400, 'rule value kind does not match flag_type');
            }
        }

        $now = ($this->clock)();
        $record = new FlagRecord($key, $flag_type, $default_value_json, $enabled, $rules_json, $now, $actor_id);
        return $this->store->save_flag_audited($record, $actor_id, $now);
    }

    private function evaluate(string $flag_key, string $want_type, mixed $caller_default, ?array $context): EvaluationDetails {
        try {
            $context = $context ?? [];
            if (!is_array($context)) {
                return $this->error_result($flag_key, $caller_default, 'GENERAL', 'context must be an array');
            }

            $rec = $this->store->get_flag($flag_key);
            if ($rec === null) {
                return $this->error_result($flag_key, $caller_default, 'FLAG_NOT_FOUND', 'flag not found');
            }

            if ($rec->type !== $want_type) {
                return $this->error_result($flag_key, $caller_default, 'TYPE_MISMATCH', 'flag type mismatch');
            }

            if (!$rec->enabled) {
                return new EvaluationDetails($flag_key, $caller_default, null, 'DISABLED', null, null);
            }

            try {
                $rules = $this->parse_rules($rec->rules_json);
                $stored_default = $this->parse_json_strict($rec->default_value_json);
            } catch (\JsonException $e) {
                return $this->error_result($flag_key, $caller_default, 'PARSE_ERROR', $e->getMessage());
            }

            $tk = null;
            if (isset($context['targeting_key']) && is_string($context['targeting_key']) && $context['targeting_key'] !== '') {
                $tk = $context['targeting_key'];
            }

            foreach ($rules as $rule) {
                if (!$this->all_conditions_match($rule['conditions'], $context)) {
                    continue;
                }
                $rollout = $rule['rollout'] ?? null;
                if ($rollout === null) {
                    return $this->serve($rule['value'], $rec, $flag_key, 'TARGETING_MATCH', $rule['variant'], $caller_default);
                }
                if ($tk === null) {
                    continue;
                }
                $percentage = $rollout['percentage'] ?? 0;
                if (!is_numeric($percentage)) {
                    continue;
                }
                $bucket = self::stable_bucket($flag_key, $tk);
                if ($bucket < $percentage) {
                    return $this->serve($rule['value'], $rec, $flag_key, 'SPLIT', $rule['variant'], $caller_default);
                }
            }

            return $this->serve($stored_default, $rec, $flag_key, 'DEFAULT', null, $caller_default);

        } catch (\Throwable $e) {
            return $this->error_result($flag_key, $caller_default, 'GENERAL', $e->getMessage());
        }
    }

    private function error_result(string $flag_key, mixed $value, string $error_code, string $message): EvaluationDetails {
        return new EvaluationDetails($flag_key, $value, null, 'ERROR', $error_code, $message);
    }

    private function serve(mixed $value, FlagRecord $rec, string $flag_key, string $reason, ?string $variant, mixed $caller_default): EvaluationDetails {
        if (!$this->kind_matches($value, $rec->type)) {
            return $this->error_result($flag_key, $caller_default, 'TYPE_MISMATCH', 'served value type mismatch');
        }
        $converted = $this->convert_value($value, $rec->type);
        return new EvaluationDetails($flag_key, $converted, $variant, $reason, null, null);
    }

    private function kind_matches(mixed $value, string $type): bool {
        switch ($type) {
            case 'boolean': return is_bool($value);
            case 'string': return is_string($value);
            case 'number': return is_int($value) || is_float($value);
            case 'object': return is_object($value) && !is_array($value);
            default: return false;
        }
    }

    private function convert_value(mixed $value, string $type): mixed {
        if ($type === 'object' && is_object($value)) {
            return $this->object_to_array($value);
        }
        return $value;
    }

    private function object_to_array(object $obj): array {
        $arr = [];
        foreach ($obj as $k => $v) {
            if (is_object($v)) {
                $arr[$k] = $this->object_to_array($v);
            } else {
                $arr[$k] = $v;
            }
        }
        return $arr;
    }

    private function parse_json_strict(string $text): mixed {
        if ($text === '') {
            throw new \JsonException('empty json');
        }
        $result = json_decode($text, false, 512, JSON_THROW_ON_ERROR);
        if (is_float($result) && !is_finite($result)) {
            throw new \JsonException('non-finite number');
        }
        return $result;
    }

    private function parse_rules(string $text): array {
        $parsed = $this->parse_json_strict($text);
        if (!is_array($parsed)) {
            throw new \JsonException('rules must be an array');
        }
        $rules = [];
        foreach ($parsed as $rule) {
            if (!is_object($rule)) {
                throw new \JsonException('rule must be an object');
            }
            $rule_arr = (array)$rule;
            if (!isset($rule_arr['conditions']) || !is_array($rule_arr['conditions'])) {
                throw new \JsonException('conditions missing or not array');
            }
            if (!isset($rule_arr['variant']) || !is_string($rule_arr['variant']) || $rule_arr['variant'] === '') {
                throw new \JsonException('variant missing or empty');
            }
            if (!array_key_exists('value', $rule_arr)) {
                throw new \JsonException('value missing');
            }
            $rollout = $rule_arr['rollout'] ?? null;
            if ($rollout !== null) {
                if (!is_object($rollout) && !is_array($rollout)) {
                    throw new \JsonException('rollout must be object or null');
                }
                $rollout_arr = is_object($rollout) ? (array)$rollout : $rollout;
                if (!isset($rollout_arr['percentage']) || !is_numeric($rollout_arr['percentage'])) {
                    throw new \JsonException('rollout.percentage must be a number');
                }
                $pct = (float)$rollout_arr['percentage'];
                if ($pct < 0 || $pct > 100) {
                    throw new \JsonException('rollout.percentage out of range');
                }
            }
            foreach ($rule_arr['conditions'] as $cond) {
                if (!is_object($cond)) {
                    throw new \JsonException('condition must be an object');
                }
                $cond_arr = (array)$cond;
                if (!isset($cond_arr['attribute']) || !is_string($cond_arr['attribute']) || $cond_arr['attribute'] === '') {
                    throw new \JsonException('condition.attribute missing or empty');
                }
                if (!isset($cond_arr['operator']) || !in_array($cond_arr['operator'], ['equals', 'not_equals', 'in_list', 'ends_with'], true)) {
                    throw new \JsonException('condition.operator invalid');
                }
                if (!array_key_exists('value', $cond_arr)) {
                    throw new \JsonException('condition.value missing');
                }
                $op = $cond_arr['operator'];
                $val = $cond_arr['value'];
                if ($op === 'equals' || $op === 'not_equals') {
                    if (!($this->is_scalar($val) && !is_null($val))) {
                        throw new \JsonException('condition.value must be scalar for equals/not_equals');
                    }
                } elseif ($op === 'in_list') {
                    if (!is_array($val)) {
                        throw new \JsonException('condition.value must be array for in_list');
                    }
                    foreach ($val as $elem) {
                        if (!($this->is_scalar($elem) && !is_null($elem))) {
                            throw new \JsonException('in_list elements must be scalar');
                        }
                    }
                } elseif ($op === 'ends_with') {
                    if (!is_string($val)) {
                        throw new \JsonException('condition.value must be string for ends_with');
                    }
                }
            }
            $rules[] = [
                'conditions' => $rule_arr['conditions'],
                'variant' => $rule_arr['variant'],
                'value' => $rule_arr['value'],
                'rollout' => $rollout
            ];
        }
        return $rules;
    }

    private function is_scalar(mixed $v): bool {
        return is_bool($v) || is_int($v) || is_float($v) || is_string($v);
    }

    private function all_conditions_match(array $conditions, array $context): bool {
        foreach ($conditions as $cond) {
            $cond_arr = is_object($cond) ? (array)$cond : $cond;
            if (!$this->condition_matches($cond_arr, $context)) {
                return false;
            }
        }
        return true;
    }

    private function condition_matches(array $cond, array $context): bool {
        $attr = $cond['attribute'];
        if (!array_key_exists($attr, $context)) {
            return false;
        }
        $x = $context[$attr];
        if (!$this->is_scalar($x)) {
            return false;
        }
        $op = $cond['operator'];
        $v = $cond['value'];
        switch ($op) {
            case 'equals':
                return $this->scalar_equal($x, $v);
            case 'not_equals':
                return !$this->scalar_equal($x, $v);
            case 'in_list':
                foreach ($v as $elem) {
                    if ($this->scalar_equal($x, $elem)) {
                        return true;
                    }
                }
                return false;
            case 'ends_with':
                return is_string($x) && is_string($v) && str_ends_with($x, $v);
            default:
                return false;
        }
    }

    private function scalar_equal(mixed $a, mixed $b): bool {
        if (is_bool($a) && is_bool($b)) return $a === $b;
        if (is_string($a) && is_string($b)) return $a === $b;
        if ((is_int($a) || is_float($a)) && (is_int($b) || is_float($b))) {
            return (float)$a === (float)$b;
        }
        return false;
    }
}