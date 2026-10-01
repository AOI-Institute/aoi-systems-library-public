import org.junit.jupiter.api.*;
import java.sql.*;
import java.time.*;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

public class QuotaManagerTest {
    private QuotaManager qm;
    private QuotaManager.User soloUser;
    private QuotaManager.User teamUser;
    private QuotaManager.User enterpriseUser;
    private Clock fixedClock;

    @BeforeEach
    public void setUp() throws Exception {
        fixedClock = Clock.fixed(Instant.parse("2024-01-01T00:00:00Z"), ZoneOffset.UTC);
        qm = new QuotaManager(fixedClock);
        soloUser = new QuotaManager.User("solo1", QuotaManager.Tier.SOLO);
        teamUser = new QuotaManager.User("team1", QuotaManager.Tier.TEAM);
        enterpriseUser = new QuotaManager.User("ent1", QuotaManager.Tier.ENTERPRISE);
    }

    @Test
    public void testApiQuotaPass() throws Exception {
        for (int i = 0; i < 1000; i++) {
            QuotaManager.Response r = qm.handleApiCall(soloUser, "/test", "127.0.0.1", null, "feature_c");
            assertEquals(200, r.getStatusCode());
        }
        // 1001st call should fail
        QuotaManager.Response r = qm.handleApiCall(soloUser, "/test", "127.0.0.1", null, "feature_c");
        assertEquals(429, r.getStatusCode());
        assertTrue(r.getBody().contains("quota_exceeded"));
    }

    @Test
    public void testApiQuotaFail() throws Exception {
        for (int i = 0; i < 1001; i++) {
            qm.handleApiCall(soloUser, "/test", "127.0.0.1", null, "feature_c");
        }
        QuotaManager.Response r = qm.handleApiCall(soloUser, "/test", "127.0.0.1", null, "feature_c");
        assertEquals(429, r.getStatusCode());
    }

    @Test
    public void testStorageQuotaPass() throws Exception {
        byte[] file = new byte[500_000_000]; // 500 MB
        QuotaManager.Response r = qm.handleApiCall(soloUser, "/upload", "127.0.0.1", file, "feature_c");
        assertEquals(200, r.getStatusCode());
    }

    @Test
    public void testStorageQuotaFail() throws Exception {
        byte[] file = new byte[1_200_000_000]; // 1.2 GB
        QuotaManager.Response r = qm.handleApiCall(soloUser, "/upload", "127.0.0.1", file, "feature_c");
        assertEquals(413, r.getStatusCode());
        assertTrue(r.getBody().contains("storage_quota_exceeded"));
    }

    @Test
    public void testRateLimitPerUserPass() throws Exception {
        for (int i = 0; i < 99; i++) {
            QuotaManager.Response r = qm.handleApiCall(teamUser, "/test", "127.0.0.1", null, "feature_c");
            assertEquals(200, r.getStatusCode());
        }
    }

    @Test
    public void testRateLimitPerUserFail() throws Exception {
        for (int i = 0; i < 100; i++) {
            qm.handleApiCall(teamUser, "/test", "127.0.0.1", null, "feature_c");
        }
        QuotaManager.Response r = qm.handleApiCall(teamUser, "/test", "127.0.0.1", null, "feature_c");
        assertEquals(429, r.getStatusCode());
        assertTrue(r.getBody().contains("rate_limit_exceeded"));
    }

    @Test
    public void testRateLimitPerIpPass() throws Exception {
        for (int i = 0; i < 9; i++) {
            QuotaManager.Response r = qm.handleApiCall(teamUser, "/test", "192.168.1.1", null, "feature_c");
            assertEquals(200, r.getStatusCode());
        }
    }

    @Test
    public void testRateLimitPerIpFail() throws Exception {
        for (int i = 0; i < 10; i++) {
            qm.handleApiCall(teamUser, "/test", "192.168.1.1", null, "feature_c");
        }
        QuotaManager.Response r = qm.handleApiCall(teamUser, "/test", "192.168.1.1", null, "feature_c");
        assertEquals(429, r.getStatusCode());
        assertTrue(r.getBody().contains("ip_rate_limit_exceeded"));
    }

    @Test
    public void testFeatureGatePass() throws Exception {
        QuotaManager.Response r = qm.handleApiCall(teamUser, "/feature", "127.0.0.1", null, "feature_a");
        assertEquals(200, r.getStatusCode());
    }

    @Test
    public void testFeatureGateFail() throws Exception {
        QuotaManager.Response r = qm.handleApiCall(soloUser, "/feature", "127.0.0.1", null, "feature_a");
        assertEquals(403, r.getStatusCode());
        assertTrue(r.getBody().contains("feature_not_available"));
    }

    @Test
    public void testMonthRollover() throws Exception {
        // Use current month usage
        qm.handleApiCall(soloUser, "/test", "127.0.0.1", null, "feature_c");
        // Advance clock to next month
        fixedClock = Clock.fixed(Instant.parse("2024-02-01T00:00:00Z"), ZoneOffset.UTC);
        qm = new QuotaManager(fixedClock);
        // Should start fresh
        QuotaManager.Response r = qm.handleApiCall(soloUser, "/test", "127.0.0.1", null, "feature_c");
        assertEquals(200, r.getStatusCode());
    }

    @Test
    public void testTierUpgrade() throws Exception {
        // Solo user makes 1000 calls
        for (int i = 0; i < 1000; i++) {
            qm.handleApiCall(soloUser, "/test", "127.0.0.1", null, "feature_c");
        }
        // Upgrade to team
        soloUser.setTier(QuotaManager.Tier.TEAM);
        // Should allow more calls
        QuotaManager.Response r = qm.handleApiCall(soloUser, "/test", "127.0.0.1", null, "feature_c");
        assertEquals(200, r.getStatusCode());
    }
}