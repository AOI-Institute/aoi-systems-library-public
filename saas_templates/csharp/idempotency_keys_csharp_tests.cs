using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using AOI.IdempotencyKeys;

public static class IdempotencyKeysTests
{
    private static int _failures = 0;
    private static int _testsRun = 0;

    public static int Main()
    {
        TestFirstCallRunsOperationOnce();
        TestSecondIdenticalCallReturnsStoredResponse();
        TestSameKeyDifferentBodyReturns422();
        TestSameKeyWhileInProgressReturns409();
        TestRequiredOperationNoKeyReturns400();
        TestSameKeyDifferentScopesIndependent();
        TestExpiredKeyRunsOperationAgain();
        TestOperationExceptionFreesKey();
        TestErrorResponsesHaveProblemJsonContentType();

        Console.WriteLine($"\n=== Results: {_testsRun} tests run, {_failures} failures ===");
        return _failures > 0 ? 1 : 0;
    }

    private static void Assert(bool condition, string message)
    {
        _testsRun++;
        if (!condition)
        {
            _failures++;
            Console.WriteLine($"FAIL: {message}");
        }
        else
        {
            Console.WriteLine($"PASS: {message}");
        }
    }

    private static void AssertEqual<T>(T expected, T actual, string message)
    {
        _testsRun++;
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            _failures++;
            Console.WriteLine($"FAIL: {message} -- expected {expected}, got {actual}");
        }
        else
        {
            Console.WriteLine($"PASS: {message}");
        }
    }

    private static IIdempotencyStore NewStore() => new InMemoryStore();

    private static IdempotencyKeys NewKeys(IIdempotencyStore store = null) => new IdempotencyKeys(store ?? NewStore());

    private static int _opCount;

    private static (int status, string body) CountingOp()
    {
        _opCount++;
        return (200, "{\"ok\":true}");
    }

    private static (int status, string body) FailingOp()
    {
        _opCount++;
        throw new InvalidOperationException("operation failed");
    }

    private static void TestFirstCallRunsOperationOnce()
    {
        _opCount = 0;
        var keys = NewKeys();
        var result = keys.Handle("client1", "key-1", "POST", "/charge", "{\"amount\":100}", CountingOp);
        AssertEqual(200, result.status, "First call returns 200");
        AssertEqual("application/json", result.contentType, "First call content-type is application/json");
        AssertEqual("{\"ok\":true}", result.body, "First call returns operation body");
        AssertEqual(1, _opCount, "Operation called exactly once");
    }

    private static void TestSecondIdenticalCallReturnsStoredResponse()
    {
        _opCount = 0;
        var keys = NewKeys();
        var result1 = keys.Handle("client1", "key-2", "POST", "/charge", "{\"amount\":100}", CountingOp);
        var result2 = keys.Handle("client1", "key-2", "POST", "/charge", "{\"amount\":100}", CountingOp);
        AssertEqual(200, result2.status, "Second call returns 200");
        AssertEqual("application/json", result2.contentType, "Second call content-type is application/json");
        AssertEqual(result1.body, result2.body, "Second call returns same body as first");
        AssertEqual(1, _opCount, "Operation called only once for two identical calls");
    }

    private static void TestSameKeyDifferentBodyReturns422()
    {
        _opCount = 0;
        var keys = NewKeys();
        var result1 = keys.Handle("client1", "key-3", "POST", "/charge", "{\"amount\":100}", CountingOp);
        var result2 = keys.Handle("client1", "key-3", "POST", "/charge", "{\"amount\":200}", CountingOp);
        AssertEqual(422, result2.status, "Different body returns 422");
        AssertEqual("application/problem+json", result2.contentType, "422 response has problem+json content-type");
        AssertEqual(1, _opCount, "Operation not called for mismatched payload");
    }

    private static void TestSameKeyWhileInProgressReturns409()
    {
        _opCount = 0;
        var store = NewStore();
        var keys = new IdempotencyKeys(store);
        var gate = new ManualResetEventSlim(false);
        var firstDone = new ManualResetEventSlim(false);
        Exception firstError = null;

        var thread = new Thread(() =>
        {
            try
            {
                keys.Handle("client1", "key-4", "POST", "/charge", "{\"amount\":100}", () =>
                {
                    gate.Set();
                    firstDone.Wait();
                    return (200, "{\"ok\":true}");
                });
            }
            catch (Exception ex)
            {
                firstError = ex;
            }
        });
        thread.Start();

        gate.Wait();
        var result2 = keys.Handle("client1", "key-4", "POST", "/charge", "{\"amount\":100}", CountingOp);
        firstDone.Set();
        thread.Join();

        AssertEqual(409, result2.status, "Concurrent call returns 409");
        AssertEqual("application/problem+json", result2.contentType, "409 response has problem+json content-type");
        AssertEqual(0, _opCount, "Second operation not started while first in progress");
        AssertNull(firstError, "First operation completed without error");
    }

    private static void TestRequiredOperationNoKeyReturns400()
    {
        _opCount = 0;
        var keys = NewKeys();
        var result = keys.Handle("client1", null, "POST", "/charge", "{\"amount\":100}", CountingOp);
        AssertEqual(400, result.status, "Missing key on required operation returns 400");
        AssertEqual("application/problem+json", result.contentType, "400 response has problem+json content-type");
        AssertEqual(0, _opCount, "Operation not called when key missing");
    }

    private static void TestSameKeyDifferentScopesIndependent()
    {
        _opCount = 0;
        var keys = NewKeys();
        var result1 = keys.Handle("clientA", "shared-key", "POST", "/charge", "{\"amount\":100}", CountingOp);
        var result2 = keys.Handle("clientB", "shared-key", "POST", "/charge", "{\"amount\":100}", CountingOp);
        AssertEqual(200, result1.status, "Client A gets 200");
        AssertEqual(200, result2.status, "Client B gets 200");
        AssertEqual(2, _opCount, "Operation called twice for different scopes");
    }

    private static void TestExpiredKeyRunsOperationAgain()
    {
        _opCount = 0;
        var store = new InMemoryStore();
        var keys = new IdempotencyKeys(store, ttl: TimeSpan.FromMilliseconds(50));
        var result1 = keys.Handle("client1", "key-expired", "POST", "/charge", "{\"amount\":100}", CountingOp);
        AssertEqual(1, _opCount, "First call runs operation");

        Thread.Sleep(100);

        var result2 = keys.Handle("client1", "key-expired", "POST", "/charge", "{\"amount\":100}", CountingOp);
        AssertEqual(2, _opCount, "Operation runs again after key expires");
        AssertEqual(200, result2.status, "Second call returns 200");
        AssertEqual("application/json", result2.contentType, "Second call content-type is application/json");
    }

    private static void TestOperationExceptionFreesKey()
    {
        _opCount = 0;
        var keys = NewKeys();
        try
        {
            keys.Handle("client1", "key-fail", "POST", "/charge", "{\"amount\":100}", FailingOp);
            Assert(false, "Expected exception from failing operation");
        }
        catch (InvalidOperationException)
        {
        }
        AssertEqual(1, _opCount, "Operation called once before failing");

        var result2 = keys.Handle("client1", "key-fail", "POST", "/charge", "{\"amount\":100}", CountingOp);
        AssertEqual(200, result2.status, "Retry after failure succeeds");
        AssertEqual(2, _opCount, "Operation called again on retry");
    }

    private static void TestErrorResponsesHaveProblemJsonContentType()
    {
        var keys = NewKeys();

        var r400 = keys.Handle("client1", null, "POST", "/charge", "{}", CountingOp);
        AssertEqual("application/problem+json", r400.contentType, "400 has problem+json content-type");
        AssertProblemBody(r400.body, "400 body has type, title, detail");

        var r422 = keys.Handle("client1", "key-err", "POST", "/charge", "{\"a\":1}", CountingOp);
        r422 = keys.Handle("client1", "key-err", "POST", "/charge", "{\"a\":2}", CountingOp);
        AssertEqual("application/problem+json", r422.contentType, "422 has problem+json content-type");
        AssertProblemBody(r422.body, "422 body has type, title, detail");

        var store = NewStore();
        var keys2 = new IdempotencyKeys(store);
        var gate = new ManualResetEventSlim(false);
        var firstDone = new ManualResetEventSlim(false);
        var thread = new Thread(() =>
        {
            keys2.Handle("client1", "key-409", "POST", "/charge", "{}", () =>
            {
                gate.Set();
                firstDone.Wait();
                return (200, "{}");
            });
        });
        thread.Start();
        gate.Wait();
        var r409 = keys2.Handle("client1", "key-409", "POST", "/charge", "{}", CountingOp);
        firstDone.Set();
        thread.Join();
        AssertEqual("application/problem+json", r409.contentType, "409 has problem+json content-type");
        AssertProblemBody(r409.body, "409 body has type, title, detail");
    }

    private static void AssertProblemBody(string json, string message)
    {
        _testsRun++;
        try
        {
            using (var doc = JsonDocument.Parse(json))
            {
                var root = doc.RootElement;
                var hasType = root.TryGetProperty("type", out var type) && type.GetString() == "https://developer.example.com/idempotency";
                var hasTitle = root.TryGetProperty("title", out var title) && !string.IsNullOrEmpty(title.GetString());
                var hasDetail = root.TryGetProperty("detail", out var detail) && !string.IsNullOrEmpty(detail.GetString());
                var hasStatus = root.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.Number;
                if (!(hasType && hasTitle && hasDetail && hasStatus))
                {
                    _failures++;
                    Console.WriteLine($"FAIL: {message} -- missing required fields in {json}");
                }
                else
                {
                    Console.WriteLine($"PASS: {message}");
                }
            }
        }
        catch (Exception ex)
        {
            _failures++;
            Console.WriteLine($"FAIL: {message} -- invalid JSON: {ex.Message}");
        }
    }

    private static void AssertNull(object obj, string message)
    {
        _testsRun++;
        if (obj != null)
        {
            _failures++;
            Console.WriteLine($"FAIL: {message} -- expected null, got {obj}");
        }
        else
        {
            Console.WriteLine($"PASS: {message}");
        }
    }
}