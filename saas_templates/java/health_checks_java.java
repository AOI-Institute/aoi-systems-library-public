import java.util.*;
import java.util.concurrent.*;
import java.util.function.*;
import java.time.*;

public final class HealthChecker {
    private final CheckStore store;
    private final HealthOptions options;
    private final LongSupplier clock;

    public HealthChecker(CheckStore store, HealthOptions options) {
        if (store == null) throw new HealthCheckError("INVALID_OPTION", 400, "invalid option: store");
        this.store = store;
        this.options = options != null ? options : new HealthOptions();
        this.clock = this.options.clock != null ? this.options.clock : () -> System.currentTimeMillis();
        validateOptions(this.options);
    }

    public void registerCheck(String componentId, String componentType, Callable<Boolean> checkFn, boolean critical, int timeoutMs) {
        validateComponentId(componentId);
        validateComponentType(componentType);
        if (checkFn == null) throw new HealthCheckError("INVALID_CHECK_FN", 400, "check_fn must be a function");
        if (timeoutMs < 1 || timeoutMs > 60000) throw new HealthCheckError("INVALID_TIMEOUT", 400, "timeout_ms must be an integer from 1 to 60000");
        RegisteredCheck check = new RegisteredCheck(componentId, componentType, checkFn, critical, timeoutMs);
        if (!store.addCheck(check)) throw new HealthCheckError("DUPLICATE_COMPONENT", 409, "component_id is already registered");
    }

    public HealthResponse liveness() {
        String body = buildBody("pass", Collections.emptyMap(), false);
        return new HealthResponse(200, "application/health+json", body);
    }

    public HealthResponse readiness() {
        List<RegisteredCheck> checks = store.listChecks();
        checks.sort(Comparator.comparing(c -> c.componentId + ":responseTime"));

        long startNanos = System.nanoTime();
        Map<String, CheckResult> results = new LinkedHashMap<>();
        ExecutorService executor = Executors.newCachedThreadPool(r -> { Thread t = new Thread(r); t.setDaemon(true); return t; });

        Map<RegisteredCheck, Future<CheckResult>> futures = new HashMap<>();
        for (RegisteredCheck check : checks) {
            futures.put(check, executor.submit(() -> runCheck(check)));
        }

        for (RegisteredCheck check : checks) {
            long deadlineNanos = startNanos + TimeUnit.MILLISECONDS.toNanos(check.timeoutMs);
            Future<CheckResult> future = futures.get(check);
            CheckResult result;

            if (future.isDone()) {
                try {
                    result = future.get();
                } catch (ExecutionException e) {
                    result = new CheckResult(CheckStatus.ERRORED, 0, clock.getAsLong(), 0);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    result = new CheckResult(CheckStatus.ERRORED, 0, clock.getAsLong(), 0);
                }
            } else {
                long remainingNanos = deadlineNanos - System.nanoTime();
                if (remainingNanos <= 0) {
                    future.cancel(true);
                    result = new CheckResult(CheckStatus.TIMED_OUT, check.timeoutMs, clock.getAsLong(), check.timeoutMs);
                } else {
                    try {
                        result = future.get(remainingNanos, TimeUnit.NANOSECONDS);
                    } catch (TimeoutException e) {
                        future.cancel(true);
                        result = new CheckResult(CheckStatus.TIMED_OUT, check.timeoutMs, clock.getAsLong(), check.timeoutMs);
                    } catch (ExecutionException e) {
                        result = new CheckResult(CheckStatus.ERRORED, 0, clock.getAsLong(), 0);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        result = new CheckResult(CheckStatus.ERRORED, 0, clock.getAsLong(), 0);
                    }
                }
            }

            if (result.status != CheckStatus.TIMED_OUT && result.realMs > check.timeoutMs) {
                result = new CheckResult(CheckStatus.TIMED_OUT, check.timeoutMs, result.timeMs, check.timeoutMs);
            }

            String key = check.componentId + ":responseTime";
            results.put(key, result);
        }

        executor.shutdownNow();

        boolean anyCriticalFail = false;
        boolean anyFail = false;
        for (Map.Entry<String, CheckResult> entry : results.entrySet()) {
            CheckStatus status = entry.getValue().status;
            if (status != CheckStatus.PASS) {
                RegisteredCheck check = findCheck(checks, entry.getKey());
                if (check != null && check.critical) anyCriticalFail = true;
                anyFail = true;
            }
        }

        String overallStatus = anyCriticalFail ? "fail" : (anyFail ? "warn" : "pass");
        int httpStatus = "fail".equals(overallStatus) ? 503 : 200;
        String body = buildBody(overallStatus, results, true);
        return new HealthResponse(httpStatus, "application/health+json", body);
    }

    private RegisteredCheck findCheck(List<RegisteredCheck> checks, String key) {
        String id = key.substring(0, key.indexOf(':'));
        for (RegisteredCheck c : checks) if (c.componentId.equals(id)) return c;
        return null;
    }

    private CheckResult runCheck(RegisteredCheck check) {
        long t0 = clock.getAsLong();
        long r0 = System.nanoTime();
        CheckStatus kind;
        try {
            Boolean v = check.checkFn.call();
            kind = Boolean.TRUE.equals(v) ? CheckStatus.PASS : CheckStatus.REPORTED;
        } catch (Throwable e) {
            kind = CheckStatus.ERRORED;
        }
        long r1 = System.nanoTime();
        long t1 = clock.getAsLong();
        long realMs = TimeUnit.NANOSECONDS.toMillis(r1 - r0);
        long observedValue = Math.max(0, t1 - t0);
        return new CheckResult(kind, observedValue, t1, realMs);
    }

    private String buildBody(String status, Map<String, CheckResult> results, boolean includeChecks) {
        StringBuilder sb = new StringBuilder();
        sb.append('{');
        appendKeyValue(sb, "status", status, true);
        appendMetadata(sb);
        if (includeChecks) {
            sb.append(",\"checks\":{");
            boolean first = true;
            for (Map.Entry<String, CheckResult> entry : results.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append('"').append(escapeJson(entry.getKey())).append("\":[");
                sb.append(buildCheckEntry(entry.getKey(), entry.getValue()));
                sb.append(']');
            }
            sb.append('}');
        }
        sb.append('}');
        return sb.toString();
    }

    private void appendMetadata(StringBuilder sb) {
        if (options.version != null && !options.version.isEmpty()) appendKeyValue(sb, "version", options.version, false);
        if (options.releaseId != null && !options.releaseId.isEmpty()) appendKeyValue(sb, "releaseId", options.releaseId, false);
        if (options.serviceId != null && !options.serviceId.isEmpty()) appendKeyValue(sb, "serviceId", options.serviceId, false);
        if (options.description != null && !options.description.isEmpty()) appendKeyValue(sb, "description", options.description, false);
    }

    private void appendKeyValue(StringBuilder sb, String key, String value, boolean first) {
        if (!first) sb.append(',');
        sb.append('"').append(escapeJson(key)).append("\":\"").append(escapeJson(value)).append('"');
    }

    private void appendKeyValueNumber(StringBuilder sb, String key, long value, boolean first) {
        if (!first) sb.append(',');
        sb.append('"').append(escapeJson(key)).append("\":").append(value);
    }

    private String buildCheckEntry(String key, CheckResult result) {
        String componentId = key.substring(0, key.indexOf(':'));
        RegisteredCheck check = findCheck(store.listChecks(), key);
        String componentType = check != null ? check.componentType : "component";
        String time = formatTime(result.timeMs);
        String output = null;
        String checkStatus = "pass";
        switch (result.status) {
            case PASS: checkStatus = "pass"; break;
            case REPORTED: checkStatus = "fail"; output = "check reported failure"; break;
            case ERRORED: checkStatus = "fail"; output = "check raised an error"; break;
            case TIMED_OUT: checkStatus = "fail"; output = "check timed out"; break;
        }
        StringBuilder sb = new StringBuilder();
        sb.append('{');
        appendKeyValue(sb, "componentId", componentId, true);
        appendKeyValue(sb, "componentType", componentType, false);
        appendKeyValueNumber(sb, "observedValue", result.observedValue, false);
        appendKeyValue(sb, "observedUnit", "ms", false);
        appendKeyValue(sb, "status", checkStatus, false);
        appendKeyValue(sb, "time", time, false);
        if (output != null) appendKeyValue(sb, "output", output, false);
        sb.append('}');
        return sb.toString();
    }

    private String formatTime(long ms) {
        long seconds = Math.floorDiv(ms, 1000L);
        return Instant.ofEpochSecond(seconds).toString();
    }

    private String escapeJson(String s) {
        StringBuilder sb = new StringBuilder();
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }

    private void validateComponentId(String id) {
        if (id == null || id.length() < 1 || id.length() > 64) throw new HealthCheckError("INVALID_COMPONENT_ID", 400, "component_id must be 1-64 characters from A-Z a-z 0-9 . _ -");
        for (char c : id.toCharArray()) {
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) {
                throw new HealthCheckError("INVALID_COMPONENT_ID", 400, "component_id must be 1-64 characters from A-Z a-z 0-9 . _ -");
            }
        }
    }

    private void validateComponentType(String type) {
        if (type == null || type.length() < 1 || type.length() > 64) throw new HealthCheckError("INVALID_COMPONENT_TYPE", 400, "component_type must be 1-64 characters from A-Z a-z 0-9 . _ -");
        for (char c : type.toCharArray()) {
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) {
                throw new HealthCheckError("INVALID_COMPONENT_TYPE", 400, "component_type must be 1-64 characters from A-Z a-z 0-9 . _ -");
            }
        }
    }

    private void validateOptions(HealthOptions opts) {
        if (opts.clock != null && !(opts.clock instanceof LongSupplier)) {
            throw new HealthCheckError("INVALID_OPTION", 400, "invalid option: clock");
        }
        String[] fields = {"version", "releaseId", "serviceId", "description"};
        for (String field : fields) {
            String val = switch (field) {
                case "version" -> opts.version;
                case "releaseId" -> opts.releaseId;
                case "serviceId" -> opts.serviceId;
                case "description" -> opts.description;
                default -> null;
            };
            if (val != null && !val.isEmpty()) {
                if (val.length() > 128) throw new HealthCheckError("INVALID_OPTION", 400, "invalid option: " + field);
                for (char c : val.toCharArray()) {
                    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == ' ' || c == '.' || c == '_' || c == ',' || c == '(' || c == ')' || c == '-')) {
                        throw new HealthCheckError("INVALID_OPTION", 400, "invalid option: " + field);
                    }
                }
            }
        }
    }

    interface CheckStore {
        boolean addCheck(RegisteredCheck check);
        List<RegisteredCheck> listChecks();
    }

    static final class InMemoryCheckStore implements CheckStore {
        private final Map<String, RegisteredCheck> checks = new ConcurrentHashMap<>();
        public boolean addCheck(RegisteredCheck check) { return checks.putIfAbsent(check.componentId, check) == null; }
        public List<RegisteredCheck> listChecks() { return new ArrayList<>(checks.values()); }
    }

    static final class RegisteredCheck {
        final String componentId;
        final String componentType;
        final Callable<Boolean> checkFn;
        final boolean critical;
        final int timeoutMs;
        RegisteredCheck(String componentId, String componentType, Callable<Boolean> checkFn, boolean critical, int timeoutMs) {
            this.componentId = componentId;
            this.componentType = componentType;
            this.checkFn = checkFn;
            this.critical = critical;
            this.timeoutMs = timeoutMs;
        }
    }

    static final class HealthOptions {
        LongSupplier clock;
        String version;
        String releaseId;
        String serviceId;
        String description;
    }

    public record HealthResponse(int httpStatus, String contentType, String body) {}

    public static final class HealthCheckError extends RuntimeException {
        private final String code;
        private final int httpStatus;
        public HealthCheckError(String code, int httpStatus, String message) {
            super(message);
            this.code = code;
            this.httpStatus = httpStatus;
        }
        public String getCode() { return code; }
        public int getHttpStatus() { return httpStatus; }
    }

    private enum CheckStatus { PASS, REPORTED, ERRORED, TIMED_OUT }

    private static final class CheckResult {
        final CheckStatus status;
        final long observedValue;
        final long timeMs;
        final long realMs;
        CheckResult(CheckStatus status, long observedValue, long timeMs, long realMs) {
            this.status = status;
            this.observedValue = observedValue;
            this.timeMs = timeMs;
            this.realMs = realMs;
        }
    }
}