package health

import (
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// CheckResult represents the result of a single health check.
type CheckResult struct {
	ComponentID   string `json:"componentId"`
	ComponentType string `json:"componentType"`
	ObservedValue string `json:"observedValue,omitempty"`
	ObservedUnit  string `json:"observedUnit,omitempty"`
	Status        string `json:"status"`
	Time          string `json:"time"`
}

// HealthResponse is the full health check response body.
type HealthResponse struct {
	Status      string                 `json:"status"`
	Version     string                 `json:"version,omitempty"`
	ReleaseID   string                 `json:"releaseId,omitempty"`
	ServiceID   string                 `json:"serviceId,omitempty"`
	Description string                 `json:"description,omitempty"`
	Checks      map[string][]CheckResult `json:"checks,omitempty"`
}

// CheckFn is the function signature for a health check.
type CheckFn func() (status string, observedValue string, observedUnit string)

// Check holds a registered health check.
type Check struct {
	ComponentID   string
	ComponentType string
	CheckFn       CheckFn
	Critical      bool
	TimeoutMs     int
}

// Registry holds all registered health checks.
type Registry struct {
	mu     sync.RWMutex
	checks map[string]Check
}

// NewRegistry creates a new health check registry.
func NewRegistry() *Registry {
	return &Registry{
		checks: make(map[string]Check),
	}
}

// RegisterCheck registers a new health check.
func (r *Registry) RegisterCheck(componentID, componentType string, checkFn CheckFn, critical bool, timeoutMs int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := componentID + ":" + componentType
	r.checks[key] = Check{
		ComponentID:   componentID,
		ComponentType: componentType,
		CheckFn:       checkFn,
		Critical:      critical,
		TimeoutMs:     timeoutMs,
	}
}

// sanitizeObservedValue removes potential connection strings or sensitive data from observed values.
func sanitizeObservedValue(value string) string {
	// Remove common connection string patterns
	if strings.Contains(value, "://") {
		return "connection failed"
	}
	if strings.Contains(value, "@") && strings.Contains(value, ":") {
		return "connection failed"
	}
	return value
}

// runCheck executes a single check with its timeout.
func (r *Registry) runCheck(check Check) CheckResult {
	result := CheckResult{
		ComponentID:   check.ComponentID,
		ComponentType: check.ComponentType,
		Status:        "fail",
		Time:          time.Now().UTC().Format(time.RFC3339),
	}

	done := make(chan struct{})
	var status, observedValue, observedUnit string

	go func() {
		status, observedValue, observedUnit = check.CheckFn()
		close(done)
	}()

	select {
	case <-done:
		result.Status = status
		result.ObservedValue = sanitizeObservedValue(observedValue)
		result.ObservedUnit = observedUnit
	case <-time.After(time.Duration(check.TimeoutMs) * time.Millisecond):
		// Timeout counts as fail
		result.ObservedValue = "timeout"
	}

	return result
}

// Liveness returns a simple "pass" response indicating the process is up.
// It does not run any dependency checks.
func (r *Registry) Liveness() map[string]interface{} {
	return map[string]interface{}{
		"http_status":  200,
		"content_type": "application/health+json",
		"body": HealthResponse{
			Status: "pass",
		},
	}
}

// Readiness runs all registered checks and returns the aggregated result.
func (r *Registry) Readiness() map[string]interface{} {
	r.mu.RLock()
	checks := make([]Check, 0, len(r.checks))
	for _, c := range r.checks {
		checks = append(checks, c)
	}
	r.mu.RUnlock()

	overallStatus := "pass"
	results := make(map[string][]CheckResult)

	for _, check := range checks {
		result := r.runCheck(check)
		key := check.ComponentID + ":" + check.ComponentType
		results[key] = []CheckResult{result}

		if result.Status == "fail" {
			if check.Critical {
				overallStatus = "fail"
			} else if overallStatus != "fail" {
				overallStatus = "warn"
			}
		} else if result.Status == "warn" && overallStatus == "pass" {
			overallStatus = "warn"
		}
	}

	httpStatus := 200
	if overallStatus == "fail" {
		httpStatus = 503
	}

	return map[string]interface{}{
		"http_status":  httpStatus,
		"content_type": "application/health+json",
		"body": HealthResponse{
			Status: overallStatus,
			Checks: results,
		},
	}
}

// MarshalBody serializes the HealthResponse body to JSON.
func MarshalBody(resp HealthResponse) ([]byte, error) {
	return json.Marshal(resp)
}