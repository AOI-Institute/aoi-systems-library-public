package idempotencykeys

import (
	"errors"
	"strings"
	"testing"
)

func TestFirstCallRunsOperationOnce(t *testing.T) {
	store := NewInMemoryStore()
	svc, _ := NewIdempotencyService(store, IdempotencyOptions{})
	count := 0
	op := func() (OperationResult, error) {
		count++
		return OperationResult{Status: 201, Body: `{"n":1}`}, nil
	}
	resp, err := svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":100}`, op)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != 201 || resp.ContentType != "application/json" || resp.Body != `{"n":1}` {
		t.Fatalf("unexpected response: %+v", resp)
	}
	if count != 1 {
		t.Fatalf("expected count 1, got %d", count)
	}
}

func TestIdenticalRetryReplaysStoredResponse(t *testing.T) {
	store := NewInMemoryStore()
	svc, _ := NewIdempotencyService(store, IdempotencyOptions{})
	count := 0
	op := func() (OperationResult, error) {
		count++
		return OperationResult{Status: 201, Body: `{"n":1}`}, nil
	}
	resp1, _ := svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":100}`, op)
	resp2, _ := svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":100}`, op)
	if resp1 != resp2 {
		t.Fatalf("responses differ: %+v vs %+v", resp1, resp2)
	}
	if count != 1 {
		t.Fatalf("expected count 1, got %d", count)
	}
}

func TestSameKeyDifferentBodyIs422(t *testing.T) {
	store := NewInMemoryStore()
	svc, _ := NewIdempotencyService(store, IdempotencyOptions{})
	count := 0
	op := func() (OperationResult, error) {
		count++
		return OperationResult{Status: 201, Body: `{"n":1}`}, nil
	}
	svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":100}`, op)
	resp, _ := svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":200}`, op)
	if resp.Status != 422 || resp.ContentType != "application/problem+json" {
		t.Fatalf("unexpected response: %+v", resp)
	}
	if resp.Body != `{"type":"https://developer.example.com/problems/idempotency-key-reused","title":"Idempotency-Key is already used","detail":"This Idempotency-Key was already used with a different request payload."}` {
		t.Fatalf("unexpected body: %s", resp.Body)
	}
	if count != 1 {
		t.Fatalf("expected count 1, got %d", count)
	}
}

func TestSameKeyWhileInProgressIs409(t *testing.T) {
	store := NewInMemoryStore()
	svc, _ := NewIdempotencyService(store, IdempotencyOptions{})
	count := 0
	var innerResp HttpResponse
	op := func() (OperationResult, error) {
		count++
		innerResp, _ = svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":100}`, func() (OperationResult, error) {
			return OperationResult{Status: 201, Body: `{"n":2}`}, nil
		})
		return OperationResult{Status: 201, Body: `{"n":1}`}, nil
	}
	resp, _ := svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":100}`, op)
	if resp.Status != 201 || resp.Body != `{"n":1}` {
		t.Fatalf("unexpected outer response: %+v", resp)
	}
	if innerResp.Status != 409 || innerResp.ContentType != "application/problem+json" {
		t.Fatalf("unexpected inner response: %+v", innerResp)
	}
	if innerResp.Body != `{"type":"https://developer.example.com/problems/idempotency-request-outstanding","title":"A request is outstanding for this Idempotency-Key","detail":"A request with the same Idempotency-Key is still being processed. Retry later."}` {
		t.Fatalf("unexpected inner body: %s", innerResp.Body)
	}
	if count != 1 {
		t.Fatalf("expected count 1, got %d", count)
	}
}

func TestRequiredMethodWithoutKeyIs400(t *testing.T) {
	store := NewInMemoryStore()
	svc, _ := NewIdempotencyService(store, IdempotencyOptions{})
	count := 0
	op := func() (OperationResult, error) {
		count++
		return OperationResult{Status: 201, Body: `{"n":1}`}, nil
	}
	resp1, _ := svc.Handle("client-a", "", "POST", "/charges", `{"amount":100}`, op)
	resp2, _ := svc.Handle("client-a", "", "POST", "/charges", `{"amount":100}`, op)
	if resp1.Status != 400 || resp1.ContentType != "application/problem+json" {
		t.Fatalf("unexpected response 1: %+v", resp1)
	}
	if resp1.Body != `{"type":"https://developer.example.com/problems/idempotency-key-missing","title":"Idempotency-Key is missing","detail":"This operation requires an Idempotency-Key request header."}` {
		t.Fatalf("unexpected body 1: %s", resp1.Body)
	}
	if resp2.Status != 400 || resp2.ContentType != "application/problem+json" {
		t.Fatalf("unexpected response 2: %+v", resp2)
	}
	if resp2.Body != `{"type":"https://developer.example.com/problems/idempotency-key-missing","title":"Idempotency-Key is missing","detail":"This operation requires an Idempotency-Key request header."}` {
		t.Fatalf("unexpected body 2: %s", resp2.Body)
	}
	if count != 0 {
		t.Fatalf("expected count 0, got %d", count)
	}
}

func TestSameKeyInTwoScopesRunsTwice(t *testing.T) {
	store := NewInMemoryStore()
	svc, _ := NewIdempotencyService(store, IdempotencyOptions{})
	count := 0
	op := func() (OperationResult, error) {
		count++
		return OperationResult{Status: 201, Body: `{"n":` + itoa(count) + `}`}, nil
	}
	resp1, _ := svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":100}`, op)
	resp2, _ := svc.Handle("client-b", "key-1", "POST", "/charges", `{"amount":100}`, op)
	if resp1.Status != 201 || resp1.Body != `{"n":1}` {
		t.Fatalf("unexpected response 1: %+v", resp1)
	}
	if resp2.Status != 201 || resp2.Body != `{"n":2}` {
		t.Fatalf("unexpected response 2: %+v", resp2)
	}
	if count != 2 {
		t.Fatalf("expected count 2, got %d", count)
	}
}

func TestExpiredKeyRunsOperationAgain(t *testing.T) {
	now := int64(1700000000)
	store := NewInMemoryStore()
	svc, _ := NewIdempotencyService(store, IdempotencyOptions{
		Clock: func() int64 { return now },
	})
	count := 0
	op := func() (OperationResult, error) {
		count++
		return OperationResult{Status: 201, Body: `{"n":` + itoa(count) + `}`}, nil
	}
	svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":100}`, op)
	now += 86400
	resp, _ := svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":100}`, op)
	if resp.Status != 201 || resp.Body != `{"n":2}` {
		t.Fatalf("unexpected response: %+v", resp)
	}
	if count != 2 {
		t.Fatalf("expected count 2, got %d", count)
	}
}

func TestRaisingOperationFreesTheKey(t *testing.T) {
	store := NewInMemoryStore()
	svc, _ := NewIdempotencyService(store, IdempotencyOptions{})
	count := 0
	boom := errors.New("boom")
	op := func() (OperationResult, error) {
		count++
		return OperationResult{}, boom
	}
	_, err := svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":100}`, op)
	if !errors.Is(err, boom) {
		t.Fatalf("expected boom error, got: %v", err)
	}
	count = 0
	op2 := func() (OperationResult, error) {
		count++
		return OperationResult{Status: 201, Body: `{"n":1}`}, nil
	}
	resp, _ := svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":100}`, op2)
	if resp.Status != 201 || resp.Body != `{"n":1}` {
		t.Fatalf("unexpected response: %+v", resp)
	}
	resp2, _ := svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":100}`, op2)
	if resp2.Status != 201 || resp2.Body != `{"n":1}` {
		t.Fatalf("unexpected replay response: %+v", resp2)
	}
	if count != 1 {
		t.Fatalf("expected count 1, got %d", count)
	}
}

func TestErrorResponsesAreProblemJson(t *testing.T) {
	store := NewInMemoryStore()
	svc, _ := NewIdempotencyService(store, IdempotencyOptions{})
	count := 0
	op := func() (OperationResult, error) {
		count++
		return OperationResult{Status: 201, Body: `{"n":1}`}, nil
	}
	resp400, _ := svc.Handle("client-a", "", "POST", "/charges", `{"amount":100}`, op)
	if resp400.Status != 400 || resp400.ContentType != "application/problem+json" {
		t.Fatalf("unexpected 400 response: %+v", resp400)
	}
	var innerResp HttpResponse
	opReentrant := func() (OperationResult, error) {
		count++
		innerResp, _ = svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":100}`, func() (OperationResult, error) {
			return OperationResult{Status: 201, Body: `{"n":2}`}, nil
		})
		return OperationResult{Status: 201, Body: `{"n":1}`}, nil
	}
	resp409, _ := svc.Handle("client-a", "key-1", "POST", "/charges", `{"amount":100}`, opReentrant)
	if resp409.Status != 201 {
		t.Fatalf("unexpected outer response: %+v", resp409)
	}
	if innerResp.Status != 409 || innerResp.ContentType != "application/problem+json" {
		t.Fatalf("unexpected 409 response: %+v", innerResp)
	}
	svc.Handle("client-a", "key-2", "POST", "/charges", `{"amount":100}`, op)
	resp422, _ := svc.Handle("client-a", "key-2", "POST", "/charges", `{"amount":200}`, op)
	if resp422.Status != 422 || resp422.ContentType != "application/problem+json" {
		t.Fatalf("unexpected 422 response: %+v", resp422)
	}
}

func TestFingerprintVectors(t *testing.T) {
	v1 := ComputeFingerprint("POST", "/charges", `{"amount":100}`)
	if v1 != "70cf65c7a3ff49d51f1453b276fad9d916ef23b88bcd6eaf7be5560757fbffac" {
		t.Fatalf("unexpected fingerprint 1: %s", v1)
	}
	v2 := ComputeFingerprint("post", "/charges", `{"amount":100}`)
	if v2 != v1 {
		t.Fatalf("fingerprints should match: %s vs %s", v1, v2)
	}
	v3 := ComputeFingerprint("POST", "/charges", `{"amount":200}`)
	if v3 != "bf84a34ee8f1f73a21d2ab06fa5bdbc2a44163460468db84a24cc19163a8dc19" {
		t.Fatalf("unexpected fingerprint 3: %s", v3)
	}
	v4 := ComputeFingerprint("POST", "/charges", "")
	if v4 != "aacec4b81fc95fe65af0e605dc76dc5705975f54fb2b55c1a3d36ff76f133334" {
		t.Fatalf("unexpected fingerprint 4: %s", v4)
	}
	v5 := ComputeFingerprint("POST", "/caf\u00e9", "\u20ac")
	if v5 != "514e90be1195bdd29a59a54bc13392840ae09b70da2fdbb3a30817f7028688ba" {
		t.Fatalf("unexpected fingerprint 5: %s", v5)
	}
	v6 := ComputeFingerprint("p\u00f6st", "/charges", "")
	if v6 != "3e0d88ec545d0bfa3805145243041df631292b351dae46b446b4c7f1b6dc54b3" {
		t.Fatalf("unexpected fingerprint 6: %s", v6)
	}
}

func TestInputValidationAndPassThrough(t *testing.T) {
	store := NewInMemoryStore()
	svc, _ := NewIdempotencyService(store, IdempotencyOptions{})
	count := 0
	op := func() (OperationResult, error) {
		count++
		return OperationResult{Status: 201, Body: `{"n":1}`}, nil
	}
	svc.Handle("client-a", "0", "POST", "/charges", `{"amount":100}`, op)
	svc.Handle("client-a", strings.Repeat("k", 255), "POST", "/charges", `{"amount":100}`, op)
	resp256, _ := svc.Handle("client-a", strings.Repeat("k", 256), "POST", "/charges", `{"amount":100}`, op)
	if resp256.Status != 400 || resp256.ContentType != "application/problem+json" {
		t.Fatalf("unexpected 256 response: %+v", resp256)
	}
	respBad, _ := svc.Handle("client-a", "bad\nkey", "POST", "/charges", `{"amount":100}`, op)
	if respBad.Status != 400 || respBad.ContentType != "application/problem+json" {
		t.Fatalf("unexpected bad key response: %+v", respBad)
	}
	_, err := svc.Handle("", "key-1", "POST", "/charges", `{"amount":100}`, op)
	if err == nil {
		t.Fatal("expected SCOPE_REQUIRED error")
	}
	var ie *IdempotencyError
	if !errors.As(err, &ie) || ie.Code != "SCOPE_REQUIRED" {
		t.Fatalf("unexpected error: %v", err)
	}
	svc.Handle("client-a", "key-1", "GET", "/charges", `{"amount":100}`, op)
	svc.Handle("client-a", "key-1", "GET", "/charges", `{"amount":100}`, op)
	if !svc.IsRequired("post", "/charges") {
		t.Fatal("expected POST to be required")
	}
	if !svc.IsRequired("PATCH", "/charges") {
		t.Fatal("expected PATCH to be required")
	}
	if svc.IsRequired("GET", "/charges") {
		t.Fatal("expected GET to not be required")
	}
	if svc.IsRequired("DELETE", "/charges") {
		t.Fatal("expected DELETE to not be required")
	}
	svcPut, _ := NewIdempotencyService(store, IdempotencyOptions{RequiredMethods: []string{"put"}})
	if !svcPut.IsRequired("PUT", "/charges") {
		t.Fatal("expected PUT to be required")
	}
	if svcPut.IsRequired("POST", "/charges") {
		t.Fatal("expected POST to not be required")
	}
	if count != 4 {
		t.Fatalf("expected count 4, got %d", count)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		pos--
		buf[pos] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}