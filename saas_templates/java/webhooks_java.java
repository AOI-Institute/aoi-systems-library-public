import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.security.*;
import javax.crypto.*;
import javax.crypto.spec.*;
import java.time.*;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.Base64;

public class Webhooks {

    /* ---------- Data Models ---------- */

    public static class WebhookEndpoint {
        public final String id;
        public final String orgId;
        public final String url;
        public String secret;
        public final Set<String> eventTypes;
        public boolean active;
        public int failureCount;
        public final long createdAt;

        public WebhookEndpoint(String id, String orgId, String url, String secret, Set<String> eventTypes, boolean active, int failureCount, long createdAt) {
            this.id = id;
            this.orgId = orgId;
            this.url = url;
            this.secret = secret;
            this.eventTypes = eventTypes;
            this.active = active;
            this.failureCount = failureCount;
            this.createdAt = createdAt;
        }
    }

    public static class WebhookMessage {
        public final String id;
        public final String eventType;
        public final String payload;
        public final long createdAt;

        public WebhookMessage(String id, String eventType, String payload, long createdAt) {
            this.id = id;
            this.eventType = eventType;
            this.payload = payload;
            this.createdAt = createdAt;
        }
    }

    public static class WebhookDelivery {
        public final String id;
        public final String messageId;
        public final String endpointId;
        public int attempt;
        public Integer statusCode;
        public boolean success;
        public String error;
        public Long nextAttemptAt;
        public Long deliveredAt;

        public WebhookDelivery(String id, String messageId, String endpointId, int attempt) {
            this.id = id;
            this.messageId = messageId;
            this.endpointId = endpointId;
            this.attempt = attempt;
            this.success = false;
            this.statusCode = null;
            this.error = null;
            this.nextAttemptAt = null;
            this.deliveredAt = null;
        }
    }

    /* ---------- Storage Interface ---------- */

    public interface Storage {
        void createEndpoint(WebhookEndpoint endpoint);
        WebhookEndpoint getEndpoint(String id);
        List<WebhookEndpoint> listActiveEndpoints(String eventType);
        void updateEndpoint(WebhookEndpoint endpoint);

        void createMessage(WebhookMessage message);
        WebhookMessage getMessage(String id);

        void createDelivery(WebhookDelivery delivery);
        WebhookDelivery getDelivery(String id);
        void updateDelivery(WebhookDelivery delivery);
        List<WebhookDelivery> listDeliveriesByMessage(String messageId);
    }

    /* ---------- In-Memory Store ---------- */

    public static class InMemoryStorage implements Storage {
        private final ConcurrentMap<String, WebhookEndpoint> endpoints = new ConcurrentHashMap<>();
        private final ConcurrentMap<String, WebhookMessage> messages = new ConcurrentHashMap<>();
        private final ConcurrentMap<String, WebhookDelivery> deliveries = new ConcurrentHashMap<>();

        @Override
        public void createEndpoint(WebhookEndpoint endpoint) {
            endpoints.put(endpoint.id, endpoint);
        }

        @Override
        public WebhookEndpoint getEndpoint(String id) {
            return endpoints.get(id);
        }

        @Override
        public List<WebhookEndpoint> listActiveEndpoints(String eventType) {
            List<WebhookEndpoint> result = new ArrayList<>();
            for (WebhookEndpoint ep : endpoints.values()) {
                if (ep.active && ep.eventTypes.contains(eventType)) {
                    result.add(ep);
                }
            }
            return result;
        }

        @Override
        public void updateEndpoint(WebhookEndpoint endpoint) {
            endpoints.put(endpoint.id, endpoint);
        }

        @Override
        public void createMessage(WebhookMessage message) {
            messages.put(message.id, message);
        }

        @Override
        public WebhookMessage getMessage(String id) {
            return messages.get(id);
        }

        @Override
        public void createDelivery(WebhookDelivery delivery) {
            deliveries.put(delivery.id, delivery);
        }

        @Override
        public WebhookDelivery getDelivery(String id) {
            return deliveries.get(id);
        }

        @Override
        public void updateDelivery(WebhookDelivery delivery) {
            deliveries.put(delivery.id, delivery);
        }

        @Override
        public List<WebhookDelivery> listDeliveriesByMessage(String messageId) {
            List<WebhookDelivery> result = new ArrayList<>();
            for (WebhookDelivery d : deliveries.values()) {
                if (d.messageId.equals(messageId)) {
                    result.add(d);
                }
            }
            return result;
        }
    }

    /* ---------- SQL Store (Skeleton) ---------- */

    public static class SQLStorage implements Storage {
        private final Connection conn;

        public SQLStorage(Connection conn) {
            this.conn = conn;
        }

        @Override
        public void createEndpoint(WebhookEndpoint endpoint) {
        }

        @Override
        public WebhookEndpoint getEndpoint(String id) {
            return null;
        }

        @Override
        public List<WebhookEndpoint> listActiveEndpoints(String eventType) {
            return Collections.emptyList();
        }

        @Override
        public void updateEndpoint(WebhookEndpoint endpoint) {
        }

        @Override
        public void createMessage(WebhookMessage message) {
        }

        @Override
        public WebhookMessage getMessage(String id) {
            return null;
        }

        @Override
        public void createDelivery(WebhookDelivery delivery) {
        }

        @Override
        public WebhookDelivery getDelivery(String id) {
            return null;
        }

        @Override
        public void updateDelivery(WebhookDelivery delivery) {
        }

        @Override
        public List<WebhookDelivery> listDeliveriesByMessage(String messageId) {
            return Collections.emptyList();
        }
    }

    /* ---------- Sender Interface ---------- */

    public interface Sender {
        int send(String url, Map<String, String> headers, String body) throws Exception;
    }

    /* ---------- Webhooks Core ---------- */

    private final Storage storage;
    private final Sender sender;
    private final SecureRandom random = new SecureRandom();
    private final Base64.Encoder base64Encoder = Base64.getEncoder().withoutPadding();
    private final Base64.Decoder base64Decoder = Base64.getDecoder();

    private final long[] backoffDelays = new long[]{5, 300, 1800, 7200, 18000, 36000, 36000};

    public Webhooks(Storage storage, Sender sender) {
        this.storage = storage;
        this.sender = sender;
    }

    /* ---------- Public API ---------- */

    public Map<String, String> createEndpoint(String orgId, String url, List<String> eventTypes) {
        if (!url.startsWith("https://") && !url.startsWith("http://localhost")) {
            throw new IllegalArgumentException("URL must be https:// or http://localhost");
        }
        String id = "ep_" + randomHex(8);
        String secret = generateSecret();
        Set<String> eventSet = new HashSet<>(eventTypes);
        long now = Instant.now().getEpochSecond();
        WebhookEndpoint ep = new WebhookEndpoint(id, orgId, url, secret, eventSet, true, 0, now);
        storage.createEndpoint(ep);
        Map<String, String> result = new HashMap<>();
        result.put("id", id);
        result.put("secret", secret);
        return result;
    }

    public String sendEvent(String eventType, String payload) {
        String msgId = "msg_" + randomHex(8);
        long now = Instant.now().getEpochSecond();
        WebhookMessage msg = new WebhookMessage(msgId, eventType, payload, now);
        storage.createMessage(msg);

        List<WebhookEndpoint> endpoints = storage.listActiveEndpoints(eventType);
        for (WebhookEndpoint ep : endpoints) {
            String deliveryId = msgId + "_" + ep.id;
            WebhookDelivery delivery = new WebhookDelivery(deliveryId, msgId, ep.id, 1);
            storage.createDelivery(delivery);
        }
        return msgId;
    }

    public String sign(String secret, String msgId, long timestamp, String body) {
        try {
            String keyB64 = secret.startsWith("whsec_") ? secret.substring(6) : secret;
            byte[] keyBytes = base64Decoder.decode(keyB64);
            SecretKeySpec keySpec = new SecretKeySpec(keyBytes, "HmacSHA256");
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(keySpec);
            String data = msgId + "." + timestamp + "." + body;
            byte[] sig = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
            String b64 = base64Encoder.encodeToString(sig);
            return "v1," + b64;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public void deliver(WebhookDelivery delivery) {
        try {
            WebhookMessage msg = storage.getMessage(delivery.messageId);
            WebhookEndpoint ep = storage.getEndpoint(delivery.endpointId);
            if (msg == null || ep == null) {
                return;
            }
            long timestamp = Instant.now().getEpochSecond();
            String signature = sign(ep.secret, msg.id, timestamp, msg.payload);
            Map<String, String> headers = new HashMap<>();
            headers.put("webhook-id", msg.id);
            headers.put("webhook-timestamp", Long.toString(timestamp));
            headers.put("webhook-signature", signature);
            headers.put("Content-Type", "application/json");
            int status = sender.send(ep.url, headers, msg.payload);
            delivery.statusCode = status;
            if (status >= 200 && status <= 299) {
                delivery.success = true;
                delivery.deliveredAt = timestamp;
            } else {
                delivery.success = false;
                delivery.error = "HTTP " + status;
                scheduleRetry(delivery);
            }
            storage.updateDelivery(delivery);
        } catch (Exception e) {
            delivery.success = false;
            delivery.error = e.getMessage();
            scheduleRetry(delivery);
            storage.updateDelivery(delivery);
        }
    }

    public boolean verify(String secret, Map<String, String> headers, String rawBody, long toleranceSeconds) {
        try {
            String msgId = headers.get("webhook-id");
            String tsStr = headers.get("webhook-timestamp");
            String sigHeader = headers.get("webhook-signature");
            if (msgId == null || tsStr == null || sigHeader == null) {
                return false;
            }
            long ts = Long.parseLong(tsStr);
            long now = Instant.now().getEpochSecond();
            if (Math.abs(now - ts) > toleranceSeconds) {
                return false;
            }
            String keyB64 = secret.startsWith("whsec_") ? secret.substring(6) : secret;
            byte[] keyBytes = base64Decoder.decode(keyB64);
            SecretKeySpec keySpec = new SecretKeySpec(keyBytes, "HmacSHA256");
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(keySpec);
            String data = msgId + "." + ts + "." + rawBody;
            byte[] expectedSig = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
            String expectedB64 = base64Encoder.encodeToString(expectedSig);

            String[] sigParts = sigHeader.split(" ");
            for (String part : sigParts) {
                String[] kv = part.split(",", 2);
                if (kv.length != 2) continue;
                String scheme = kv[0];
                String sig = kv[1];
                if (!"v1".equals(scheme)) continue;
                if (constantTimeEquals(expectedB64, sig)) {
                    return true;
                }
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    public String rotateSecret(String endpointId) {
        WebhookEndpoint ep = storage.getEndpoint(endpointId);
        if (ep == null) {
            throw new IllegalArgumentException("Endpoint not found");
        }
        String newSecret = generateSecret();
        ep.secret = newSecret;
        storage.updateEndpoint(ep);
        return newSecret;
    }

    /* ---------- Helpers ---------- */

    private String generateSecret() {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        return "whsec_" + base64Encoder.encodeToString(bytes);
    }

    private void scheduleRetry(WebhookDelivery delivery) {
        delivery.attempt += 1;
        int idx = delivery.attempt - 1;
        long delay = idx < backoffDelays.length ? backoffDelays[idx] : backoffDelays[backoffDelays.length - 1];
        long now = Instant.now().getEpochSecond();
        delivery.nextAttemptAt = now + delay;
        WebhookEndpoint ep = storage.getEndpoint(delivery.endpointId);
        if (ep != null) {
            ep.failureCount += 1;
            if (ep.failureCount >= 5) {
                ep.active = false;
            }
            storage.updateEndpoint(ep);
        }
    }

    private boolean constantTimeEquals(String a, String b) {
        byte[] aBytes = a.getBytes(StandardCharsets.UTF_8);
        byte[] bBytes = b.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(aBytes, bBytes);
    }

    private String randomHex(int byteLength) {
        byte[] bytes = new byte[byteLength];
        random.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(byteLength * 2);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }
}