package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEnqueueJob(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.Default()
	
	js := &JobService{
		db:    setupTestDB(t),
		redis: setupTestRedis(t),
	}
	router.POST("/jobs/enqueue", js.EnqueueJob)

	reqBody := map[string]interface{}{
		"task_type": "send_bulk_email",
		"params": map[string]interface{}{
			"template_key": "trial_ending_soon",
			"filter": map[string]interface{}{
				"trial_days_left": map[string]interface{}{
					"$lte": 7,
				},
			},
		},
		"max_retries": 3,
	}

	req, _ := json.Marshal(reqBody)
	reqRecorder := httptest.NewRecorder()
	reqTest := httptest.NewRequest("POST", "/jobs/enqueue", bytes.NewBuffer(req))
	router.ServeHTTP(reqRecorder, reqTest)

	assert.Equal(t, http.StatusOK, reqRecorder.Code)
	
	var response map[string]interface{}
	json.Unmarshal(reqRecorder.Body.Bytes(), &response)
	assert.True(t, response["success"].(bool))
	assert.NotEmpty(t, response["job_id"])
	assert.Equal(t, "enqueued", response["status"])
}

func TestGetJobStatus(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.Default()
	
	js := &JobService{
		db:    setupTestDB(t),
		redis: setupTestRedis(t),
	}
	router.GET("/jobs/:job_id", js.GetJobStatus)

	jobID := createTestJob(t, js.db, "send_bulk_email")
	
	reqRecorder := httptest.NewRecorder()
	reqTest := httptest.NewRequest("GET", fmt.Sprintf("/jobs/%s", jobID), nil)
	router.ServeHTTP(reqRecorder, reqTest)

	assert.Equal(t, http.StatusOK, reqRecorder.Code)
	
	var response map[string]interface{}
	json.Unmarshal(reqRecorder.Body.Bytes(), &response)
	assert.Equal(t, jobID, response["job_id"])
	assert.Equal(t, "send_bulk_email", response["task_type"])
	assert.Equal(t, "enqueued", response["status"])
}

func TestListJobs(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.Default()
	
	js := &JobService{
		db:    setupTestDB(t),
		redis: setupTestRedis(t),
	}
	router.GET("/jobs", js.ListJobs)

	createTestJob(t, js.db, "send_bulk_email")
	createTestJob(t, js.db, "webhook_retry")
	
	reqRecorder := httptest.NewRecorder()
	reqTest := httptest.NewRequest("GET", "/jobs?limit=10", nil)
	router.ServeHTTP(reqRecorder, reqTest)

	assert.Equal(t, http.StatusOK, reqRecorder.Code)
	
	var response map[string]interface{}
	json.Unmarshal(reqRecorder.Body.Bytes(), &response)
	jobs := response["jobs"].([]interface{})
	assert.GreaterOrEqual(t, len(jobs), 2)
}

func TestCancelJob(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.Default()
	
	js := &JobService{
		db:    setupTestDB(t),
		redis: setupTestRedis(t),
	}
	router.DELETE("/jobs/:job_id", js.CancelJob)

	jobID := createTestJob(t, js.db, "send_bulk_email")
	
	reqRecorder := httptest.NewRecorder()
	reqTest := httptest.NewRequest("DELETE", fmt.Sprintf("/jobs/%s", jobID), nil)
	router.ServeHTTP(reqRecorder, reqTest)

	assert.Equal(t, http.StatusOK, reqRecorder.Code)
	
	var response map[string]interface{}
	json.Unmarshal(reqRecorder.Body.Bytes(), &response)
	assert.True(t, response["success"].(bool))
	assert.Equal(t, "cancelled", response["status"])
}

func TestRetryJob(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.Default()
	
	js := &JobService{
		db:    setupTestDB(t),
		redis: setupTestRedis(t),
	}
	router.POST("/jobs/:job_id/retry", js.RetryJob)

	jobID := createTestJob(t, js.db, "send_bulk_email")
	
	reqRecorder := httptest.NewRecorder()
	reqTest := httptest.NewRequest("POST", fmt.Sprintf("/jobs/%s/retry", jobID), nil)
	router.ServeHTTP(reqRecorder, reqTest)

	assert.Equal(t, http.StatusOK, reqRecorder.Code)
	
	var response map[string]interface{}
	json.Unmarshal(reqRecorder.Body.Bytes(), &response)
	assert.True(t, response["success"].(bool))
	assert.NotEmpty(t, response["new_job_id"])
	assert.Equal(t, "enqueued", response["status"])
}

func TestGetJobResults(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.Default()
	
	js := &JobService{
		db:    setupTestDB(t),
		redis: setupTestRedis(t),
	}
	router.GET("/jobs/:job_id/results", js.GetJobResults)

	jobID := createTestJob(t, js.db, "send_bulk_email")
	
	reqRecorder := httptest.NewRecorder()
	reqTest := httptest.NewRequest("GET", fmt.Sprintf("/jobs/%s/results", jobID), nil)
	router.ServeHTTP(reqRecorder, reqTest)

	assert.Equal(t, http.StatusBadRequest, reqRecorder.Code)
	
	var response map[string]interface{}
	json.Unmarshal(reqRecorder.Body.Bytes(), &response)
	assert.Contains(t, response["error"], "Results only available for completed jobs")
}

func TestWorkerProcessesJob(t *testing.T) {
	js := &JobService{
		db:    setupTestDB(t),
		redis: setupTestRedis(t),
	}

	jobID := createTestJob(t, js.db, "send_bulk_email")
	js.redis.LPush(context.Background(), "job_queue", jobID)
	
	time.Sleep(100 * time.Millisecond)
	
	job, err := js.getJob(jobID)
	require.NoError(t, err)
	assert.Equal(t, "running", job.Status)
}

func setupTestDB(t *testing.T) *sql.DB {
	db, err := sql.Open("postgres", "user=postgres dbname=test password=postgres host=localhost sslmode=disable")
	require.NoError(t, err)
	
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS jobs (
			id VARCHAR(36) PRIMARY KEY,
			task_type VARCHAR(255) NOT NULL,
			params JSONB,
			status VARCHAR(50) NOT NULL,
			created_at TIMESTAMP WITH TIME ZONE NOT NULL,
			started_at TIMESTAMP WITH TIME ZONE,
			completed_at TIMESTAMP WITH TIME ZONE,
			progress VARCHAR(50),
			result JSONB,
			error TEXT,
			retry_count INTEGER NOT NULL DEFAULT 0,
			max_retries INTEGER NOT NULL DEFAULT 3,
			next_retry_at TIMESTAMP WITH TIME ZONE,
			scheduled_at TIMESTAMP WITH TIME ZONE
		);
	`)
	require.NoError(t, err)
	
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS job_runs (
			id VARCHAR(36) PRIMARY KEY,
			job_id VARCHAR(36) NOT NULL,
			status VARCHAR(50) NOT NULL,
			started_at TIMESTAMP WITH TIME ZONE NOT NULL,
			completed TIMESTAMP WITH TIME ZONE,
			result TEXT,
			FOREIGN KEY (job_id) REFERENCES jobs(id)
		);
	`)
	require.NoError(t, err)
	
	return db
}

func setupTestRedis(t *testing.T) *redis.Client {
	rdb := redis.NewClient(&redis.Options{
		Addr: "localhost:6379",
	})
	
	rdb.FlushDB(context.Background())
	return rdb
}

func createTestJob(t *testing.T, db *sql.DB, taskType string) string {
	jobID := uuid.New().String()
	params, _ := json.Marshal(map[string]interface{}{
		"template_key": "test",
	})
	
	_, err := db.Exec(
		"INSERT INTO jobs (id, task_type, params, status, created_at) VALUES ($1, $2, $3, $4, $5)",
		jobID, taskType, params, "enqueued", time.Now(),
	)
	require.NoError(t, err)
	
	return jobID
}