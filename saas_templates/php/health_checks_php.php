<?php
/**
 * Health Checks (Liveness + Readiness) implementation.
 * No external dependencies, in-memory registry only.
 */

class CheckRegistry
{
    private static array $checks = [];

    public static function register(
        string $component_id,
        string $component_type,
        callable $check_fn,
        bool $critical,
        int $timeout_ms
    ): void {
        self::$checks[] = [
            'component_id' => $component_id,
            'component_type' => $component_type,
            'check_fn' => $check_fn,
            'critical' => $critical,
            'timeout_ms' => $timeout_ms,
        ];
    }

    /** @return array */
    public static function get_checks(): array
    {
        return self::$checks;
    }

    public static function reset(): void
    {
        self::$checks = [];
    }
}

function liveness(): array
{
    $body = ['status' => 'pass'];
    return [
        'http_status' => 200,
        'content_type' => 'application/health+json',
        'body' => json_encode($body),
    ];
}

function readiness(): array
{
    $checks = CheckRegistry::get_checks();
    $results = [];
    $overall_status = 'pass';

    foreach ($checks as $check) {
        $start = microtime(true);
        $status = 'pass';
        $observedValue = null;
        $observedUnit = null;

        try {
            $ret = call_user_func($check['check_fn']);
            if (is_array($ret)) {
                $status = $ret['status'] ?? 'pass';
                $observedValue = $ret['observedValue'] ?? null;
                $observedUnit = $ret['observedUnit'] ?? null;
            }
        } catch (Throwable $e) {
            $status = 'fail';
        }

        $elapsed_ms = (microtime(true) - $start) * 1000;
        if ($elapsed_ms > $check['timeout_ms']) {
            $status = 'fail';
        }

        $results[$check['component_id']] = [
            'componentId' => $check['component_id'],
            'componentType' => $check['component_type'],
            'observedValue' => $observedValue,
            'observedUnit' => $observedUnit,
            'status' => $status,
            'time' => round($elapsed_ms, 2),
        ];

        if ($status !== 'pass') {
            if ($check['critical']) {
                $overall_status = 'fail';
            } else {
                if ($overall_status !== 'fail') {
                    $overall_status = 'warn';
                }
            }
        }
    }

    $body = [
        'status' => $overall_status,
        'checks' => $results,
    ];

    $http_status = ($overall_status === 'pass' || $overall_status === 'warn') ? 200 : 503;

    return [
        'http_status' => $http_status,
        'content_type' => 'application/health+json',
        'body' => json_encode($body),
    ];
}