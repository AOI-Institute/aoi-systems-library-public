import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

public class idempotency_keys_java_tests {

    private static void assertEquals(Object expected, Object actual) {
        if (!java.util.Objects.equals(expected, actual)) {
            throw new AssertionError("Expected: " + expected + ", but got: " + actual);
        }
    }

    private static void assertTrue(boolean condition) {
        if (!condition) {
            throw new AssertionError("Expected true, but got false");
        }
    }

    private static void assertFalse(boolean condition) {
        if (condition) {
            throw new AssertionError("Expected false, but got true");
        }
    }

    private static class TestFixture {
        final IdempotencyKeys.InMemoryStore store;
        final AtomicLong clockVal;
        final IdempotencyKeys.IdempotencyService service;
        final AtomicInteger opCount;

        TestFixture() {
            this.store = new IdempotencyKeys.InMemoryStore();
            this.clockVal = new AtomicLong(1700000000L);
            IdempotencyKeys.IdempotencyOptions opts = new IdempotencyKeys.IdempotencyOptions();
            opts.clock = clockVal::get;
            this.service = new IdempotencyKeys.IdempotencyService(store, opts);
            this.opCount = new AtomicInteger(0);
        }

        IdempotencyKeys.OperationResult nextOp() {
            int count = opCount.incrementAndGet();
            return new IdempotencyKeys.OperationResult(201, "{\"n\":" + count + "}");
        }
    }

    public static void testFirstCallRunsOperationOnce() {
        TestFixture f = new TestFixture();
        IdempotencyKeys.HttpResponse res = f.service.handle(
            "client-a", "key-1", "POST", "/charges", "{\"amount\":100}",
            f::nextOp
        );
        assertEquals(201, res.status());
        assertEquals("application/json", res.contentType());
        assertEquals("{\"n\":1}", res.body());
        assertEquals(1, f.opCount.get());
    }

    public static void testIdenticalRetryReplaysStoredResponse() {
        TestFixture f = new TestFixture();
        IdempotencyKeys.HttpResponse res1 = f.service.handle(
            "client-a", "key-1", "POST", "/charges", "{\"amount\":100}",
            f::nextOp
        );
        IdempotencyKeys.HttpResponse res2 = f.service.handle(
            "client-a", "key-1", "POST", "/charges", "{\"amount\":100}",
            f::nextOp
        );
        assertEquals(201, res2.status());
        assertEquals("application/json", res2.contentType());
        assertEquals("{\"n\":1}", res2.body());
        assertEquals(1, f.opCount.get());
    }

    public static void testSameKeyDifferentBodyIs422() {
        TestFixture f = new TestFixture();
        f.service.handle("client-a", "key-1", "POST", "/charges", "{\"amount\":100}", f::nextOp);
        IdempotencyKeys.HttpResponse res = f.service.handle(
            "client-a", "key-1", "POST", "/charges", "{\"amount\":200}",
            f::nextOp
        );
        assertEquals(422, res.status());
        assertEquals("application/problem+json", res.contentType());
        assertTrue(res.body().contains("idempotency-key-reused"));
        assertEquals(1, f.opCount.get());
    }

    public static void testSameKeyWhileInProgressIs409() {
        TestFixture f = new TestFixture();
        AtomicReference<IdempotencyKeys.HttpResponse> innerRes = new AtomicReference<>();
        IdempotencyKeys.HttpResponse outerRes = f.service.handle(
            "client-a", "key-1", "POST", "/charges", "{\"amount\":100}",
            () -> {
                innerRes.set(f.service.handle(
                    "client-a", "key-1", "POST", "/charges", "{\"amount\":100}",
                    f::nextOp
                ));
                return f.nextOp();
            }
        );
        assertEquals(201, outerRes.status());
        assertEquals("{\"n\":1}", outerRes.body());
        
        IdempotencyKeys.HttpResponse inner = innerRes.get();
        assertEquals(409, inner.status());
        assertEquals("application/problem+json", inner.contentType());
        assertTrue(inner.body().contains("idempotency-request-outstanding"));
        assertEquals(1, f.opCount.get());
    }

    public static void testRequiredMethodWithoutKeyIs400() {
        TestFixture f = new TestFixture();
        IdempotencyKeys.HttpResponse resNull = f.service.handle(
            "client-a", null, "POST", "/charges", "{\"amount\":100}",
            f::nextOp
        );
        assertEquals(400, resNull.status());
        assertEquals("application/problem+json", resNull.contentType());
        assertTrue(resNull.body().contains("idempotency-key-missing"));

        IdempotencyKeys.HttpResponse resEmpty = f.service.handle(
            "client-a", "", "POST", "/charges", "{\"amount\":100}",
            f::nextOp
        );
        assertEquals(400, resEmpty.status());
        assertEquals("application/problem+json", resEmpty.contentType());
        assertTrue(resEmpty.body().contains("idempotency-key-missing"));
        assertEquals(0, f.opCount.get());
    }

    public static void testSameKeyInTwoScopesRunsTwice() {
        TestFixture f = new TestFixture();
        IdempotencyKeys.HttpResponse res1 = f.service.handle(
            "client-a", "key-1", "POST", "/charges", "{\"amount\":100}",
            f::nextOp
        );
        IdempotencyKeys.HttpResponse res2 = f.service.handle(
            "client-b", "key-1", "POST", "/charges", "{\"amount\":100}",
            f::nextOp
        );
        assertEquals(201, res1.status());
        assertEquals("{\"n\":1}", res1.body());
        assertEquals(201, res2.status());
        assertEquals("{\"n\":2}", res2.body());
        assertEquals(2, f.opCount.get());
    }

    public static void testExpiredKeyRunsOperationAgain() {
        TestFixture f = new TestFixture();
        f.service.handle("client-a", "key-1", "POST", "/charges", "{\"amount\":100}", f::nextOp);
        
        f.clockVal.addAndGet(86400);
        
        IdempotencyKeys.HttpResponse res = f.service.handle(
            "client-a", "key-1", "POST", "/charges", "{\"amount\":100}",
            f::nextOp
        );
        assertEquals(201, res.status());
        assertEquals("{\"n\":2}", res.body());
        assertEquals(2, f.opCount.get());
    }

    public static void testRaisingOperationFreesTheKey() {
        TestFixture f = new TestFixture();
        RuntimeException boom = new RuntimeException("Operation failed");
        
        try {
            f.service.handle("client-a", "key-1", "POST", "/charges", "{\"amount\":100}", () -> {
                throw boom;
            });
            throw new AssertionError("Expected exception to propagate");
        } catch (RuntimeException e) {
            assertTrue(e == boom);
        }

        IdempotencyKeys.HttpResponse res = f.service.handle(
            "client-a", "key-1", "POST", "/charges", "{\"amount\":100}",
            f::nextOp
        );
        assertEquals(201, res.status());
        assertEquals("{\"n\":1}", res.body());

        IdempotencyKeys.HttpResponse res3 = f.service.handle(
            "client-a", "key-1", "POST", "/charges", "{\"amount\":100}",
            f::nextOp
        );
        assertEquals(201, res3.status());
        assertEquals("{\"n\":1}", res3.body());
        assertEquals(1, f.opCount.get());
    }

    public static void testErrorResponsesAreProblemJson() {
        TestFixture f = new TestFixture();
        
        IdempotencyKeys.HttpResponse res400 = f.service.handle("client-a", null, "POST", "/charges", "", f::nextOp);
        assertEquals(400, res400.status());
        assertEquals("application/problem+json", res400.contentType());
        assertTrue(res400.body().contains("idempotency-key-missing"));

        f.service.handle("client-a", "key-1", "POST", "/charges", "{\"amount\":100}", f::nextOp);
        IdempotencyKeys.HttpResponse res422 = f.service.handle("client-a", "key-1", "POST", "/charges", "{\"amount\":200}", f::nextOp);
        assertEquals(422, res422.status());
        assertEquals("application/problem+json", res422.contentType());
        assertTrue(res422.body().contains("idempotency-key-reused"));

        f.service.handle("client-a", "key-2", "POST", "/charges", "{\"amount\":100}", () -> {
            IdempotencyKeys.HttpResponse res409 = f.service.handle("client-a", "key-2", "POST", "/charges", "{\"amount\":100}", f::nextOp);
            assertEquals(409, res409.status());
            assertEquals("application/problem+json", res409.contentType());
            assertTrue(res409.body().contains("idempotency-request-outstanding"));
            return f.nextOp();
        });
    }

    public static void testInProgressWithDifferentBodyIs422() {
        TestFixture f = new TestFixture();
        AtomicReference<IdempotencyKeys.HttpResponse> innerRes = new AtomicReference<>();
        f.service.handle("client-a", "key-1", "POST", "/charges", "{\"amount\":100}", () -> {
            innerRes.set(f.service.handle(
                "client-a", "key-1", "POST", "/charges", "{\"amount\":200}",
                f::nextOp
            ));
            return f.nextOp();
        });
        IdempotencyKeys.HttpResponse inner = innerRes.get();
        assertEquals(422, inner.status());
        assertEquals("application/problem+json", inner.contentType());
        assertTrue(inner.body().contains("idempotency-key-reused"));
    }

    public static void testExpiryBoundaryAndPurge() {
        TestFixture f = new TestFixture();
        f.service.handle("client-a", "key-1", "POST", "/charges", "{\"amount\":100}", f::nextOp);

        f.clockVal.set(1700000000L + 86399);
        IdempotencyKeys.HttpResponse res1 = f.service.handle("client-a", "key-1", "POST", "/charges", "{\"amount\":100}", f::nextOp);
        assertEquals(201, res1.status());
        assertEquals("{\"n\":1}", res1.body());
        assertEquals(0, f.service.purgeExpired());

        f.clockVal.set(1700000000L + 86400);
        assertEquals(1, f.service.purgeExpired());
        IdempotencyKeys.HttpResponse res2 = f.service.handle("client-a", "key-1", "POST", "/charges", "{\"amount\":100}", f::nextOp);
        assertEquals(201, res2.status());
        assertEquals("{\"n\":2}", res2.body());
    }

    public static void testScopeAndKeyNeverCollide() {
        TestFixture f = new TestFixture();
        f.service.handle("a:b", "c", "POST", "/charges", "", f::nextOp);
        f.service.handle("a", "b:c", "POST", "/charges", "", f::nextOp);
        f.service.handle("a|b", "c", "POST", "/charges", "", f::nextOp);
        f.service.handle("a", "b|c", "POST", "/charges", "", f::nextOp);
        assertEquals(4, f.opCount.get());
    }

    public static void testNoRerunAfterOperationReturned() {
        TestFixture f = new TestFixture();
        IdempotencyKeys.Store badStore = new IdempotencyKeys.Store() {
            @Override
            public boolean tryClaim(IdempotencyKeys.IdempotencyRecord record, long now) {
                return f.store.tryClaim(record, now);
            }
            @Override
            public IdempotencyKeys.IdempotencyRecord get(String scope, String idemKey) {
                return f.store.get(scope, idemKey);
            }
            @Override
            public void complete(String scope, String idemKey, long createdAt, int responseStatus, String responseBody) {
                throw new IdempotencyKeys.IdempotencyError("STORE_ERROR", 500, "down");
            }
            @Override
            public void delete(String scope, String idemKey, long createdAt) {
                f.store.delete(scope, idemKey, createdAt);
            }
            @Override
            public int purgeExpired(long now) {
                return f.store.purgeExpired(now);
            }
        };
        IdempotencyKeys.IdempotencyOptions opts = new IdempotencyKeys.IdempotencyOptions();
        opts.clock = f.clockVal::get;
        IdempotencyKeys.IdempotencyService badService = new IdempotencyKeys.IdempotencyService(badStore, opts);

        try {
            badService.handle("client-a", "key-1", "POST", "/charges", "", f::nextOp);
            throw new AssertionError("Expected STORE_ERROR");
        } catch (IdempotencyKeys.IdempotencyError e) {
            assertEquals("STORE_ERROR", e.code);
        }

        IdempotencyKeys.HttpResponse resRetry = badService.handle("client-a", "key-1", "POST", "/charges", "", f::nextOp);
        assertEquals(409, resRetry.status());
        assertEquals(1, f.opCount.get());

        TestFixture f2 = new TestFixture();
        try {
            f2.service.handle("client-a", "key-1", "POST", "/charges", "", () -> new IdempotencyKeys.OperationResult(99, "bad"));
            throw new AssertionError("Expected INVALID_OPERATION_RESULT");
        } catch (IdempotencyKeys.IdempotencyError e) {
            assertEquals("INVALID_OPERATION_RESULT", e.code);
        }

        IdempotencyKeys.HttpResponse resRetry2 = f2.service.handle("client-a", "key-1", "POST", "/charges", "", f2::nextOp);
        assertEquals(409, resRetry2.status());
        assertEquals(0, f2.opCount.get());
    }

    public static void testFingerprintVectors() {
        assertEquals(
            "70cf65c7a3ff49d51f1453b276fad9d916ef23b88bcd6eaf7be5560757fbffac",
            IdempotencyKeys.computeFingerprint("POST", "/charges", "{\"amount\":100}")
        );
        assertEquals(
            "70cf65c7a3ff49d51f1453b276fad9d916ef23b88bcd6eaf7be5560757fbffac",
            IdempotencyKeys.computeFingerprint("post", "/charges", "{\"amount\":100}")
        );
        assertEquals(
            "bf84a34ee8f1f73a21d2ab06fa5bdbc2a44163460468db84a24cc19163a8dc19",
            IdempotencyKeys.computeFingerprint("POST", "/charges", "{\"amount\":200}")
        );
        assertEquals(
            "aacec4b81fc95fe65af0e605dc76dc5705975f54fb2b55c1a3d36ff76f133334",
            IdempotencyKeys.computeFingerprint("POST", "/charges", "")
        );
        assertEquals(
            "514e90be1195bdd29a59a54bc13392840ae09b70da2fdbb3a30817f7028688ba",
            IdempotencyKeys.computeFingerprint("POST", "/caf\u00e9", "\u20ac")
        );
        assertEquals(
            "3e0d88ec545d0bfa3805145243041df631292b351dae46b446b4c7f1b6dc54b3",
            IdempotencyKeys.computeFingerprint("p\u00f6st", "/charges", "")
        );
    }

    public static void testInputValidationAndPassThrough() {
        TestFixture f = new TestFixture();
        
        IdempotencyKeys.HttpResponse r0 = f.service.handle("client-a", "0", "POST", "/charges", "", f::nextOp);
        assertEquals(201, r0.status());
        
        String k255 = "k".repeat(255);
        IdempotencyKeys.HttpResponse r255 = f.service.handle("client-a", k255, "POST", "/charges", "", f::nextOp);
        assertEquals(201, r255.status());

        String k256 = "k".repeat(256);
        IdempotencyKeys.HttpResponse r256 = f.service.handle("client-a", k256, "POST", "/charges", "", f::nextOp);
        assertEquals(400, r256.status());
        assertTrue(r256.body().contains("idempotency-key-invalid"));

        IdempotencyKeys.HttpResponse rBad = f.service.handle("client-a", "bad\nkey", "POST", "/charges", "", f::nextOp);
        assertEquals(400, rBad.status());
        assertTrue(rBad.body().contains("idempotency-key-invalid"));

        try {
            f.service.handle("", "key-valid", "POST", "/charges", "", f::nextOp);
            throw new AssertionError("Expected SCOPE_REQUIRED");
        } catch (IdempotencyKeys.IdempotencyError e) {
            assertEquals("SCOPE_REQUIRED", e.code);
        }

        IdempotencyKeys.HttpResponse rGet1 = f.service.handle("client-a", null, "GET", "/charges", "", f::nextOp);
        assertEquals(201, rGet1.status());
        assertEquals("application/json", rGet1.contentType());

        IdempotencyKeys.HttpResponse rGet2 = f.service.handle("client-a", null, "GET", "/charges", "", f::nextOp);
        assertEquals(201, rGet2.status());
        assertEquals("application/json", rGet2.contentType());

        assertEquals(4, f.opCount.get());

        assertTrue(f.service.isRequired("post", "/charges"));
        assertTrue(f.service.isRequired("PATCH", "/charges"));
        assertFalse(f.service.isRequired("GET", "/charges"));
        assertFalse(f.service.isRequired("DELETE", "/charges"));

        IdempotencyKeys.IdempotencyOptions opts = new IdempotencyKeys.IdempotencyOptions();
        opts.requiredMethods = Set.of("put");
        IdempotencyKeys.IdempotencyService customService = new IdempotencyKeys.IdempotencyService(f.store, opts);
        assertTrue(customService.isRequired("PUT", "/charges"));
        assertFalse(customService.isRequired("POST", "/charges"));
    }

    public static void main(String[] args) {
        try {
            testFirstCallRunsOperationOnce();
            testIdenticalRetryReplaysStoredResponse();
            testSameKeyDifferentBodyIs422();
            testSameKeyWhileInProgressIs409();
            testRequiredMethodWithoutKeyIs400();
            testSameKeyInTwoScopesRunsTwice();
            testExpiredKeyRunsOperationAgain();
            testRaisingOperationFreesTheKey();
            testErrorResponsesAreProblemJson();
            testInProgressWithDifferentBodyIs422();
            testExpiryBoundaryAndPurge();
            testScopeAndKeyNeverCollide();
            testNoRerunAfterOperationReturned();
            testFingerprintVectors();
            testInputValidationAndPassThrough();
            System.out.println("All tests passed successfully!");
        } catch (Throwable t) {
            t.printStackTrace();
            System.exit(1);
        }
    }
}