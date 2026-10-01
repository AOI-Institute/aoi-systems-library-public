package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/google/uuid"
	_ "github.com/lib/pq"
)

type JobStatus string

const (
	JobStatusEnqueued  JobStatus = "enqueued"
	JobStatusRunning   JobStatus = "running"
	JobStatusCompleted JobStatus = "completed"
	JobStatusFailed    JobStatus = "failed"
	JobStatusCancelled JobStatus = "cancelled"
)

type Job struct {
	ID           string          `json:"id"`
	TaskType     string          `json:"task_type"`
	Params       json.RawMessage `json:"params"`
	Status       JobStatus       `json:"status"`
	CreatedAt    time.Time       `json:"created_at"`
	StartedAt    *time.Time      `json:"started_at"`
	CompletedAt  *time.Time      `json:"completed_at"`
	Progress     string          `json:"progress"`
	Result       json.RawMessage `json:"result"`
	Error        sql.NullString  `json:"error"`
	RetryCount   int             `json:"retry_count"`
	MaxRetries   int             `json:"max_retries"`
	NextRetryAt  *time.Time      `json:"next_retry_at"`
	ScheduledAt  *time.Time      `json:"scheduled_at"`
}

type JobRun struct {
	ID        string     `json:"id"`
	JobID     string     `json:"job_id"`
	Status    string     `json:"status"`
	StartedAt time.Time  `json:"started_at"`
	Completed *time.Time `json:"completed"`
	Result    string     `json:"result"`
}

type JobService struct {
	db    *sql.DB
	redis *redis.Client
}

type EnqueueRequest struct {
	TaskType   string          `json:"task_type"`
	Params     json.RawMessage `json:"params"`
	ScheduledAt string          `json:"scheduled_at,omitempty"`
	MaxRetries int             `json:"max_retries,omitempty"`
}

type JobResponse struct {
	Success bool      `json:"success"`
	JobID   string    `json:"job_id"`
	Status  JobStatus `json:"status"`
}

type JobStatusResponse struct {
	JobID       string          `json:"job_id"`
	TaskType    string          `json:"task_type"`
	Status      JobStatus       `json:"status"`
	Progress    string          `json:"progress"`
	CreatedAt   time.Time       `json:"created_at"`
	StartedAt   *time.Time      `json:"started_at"`
	Result      json.RawMessage `json:"result"`
	NextRetryAt *time.Time      `json:"next_retry_at"`
}

type ListJobsResponse struct {
	Jobs  []Job `json:"jobs"`
	Total int   `json:"total"`
}

type ResultsResponse struct {
	JobID      string          `json:"job_id"`
	Status     JobStatus       `json:"status"`
	Result     json.RawMessage `json:"result"`
	CompletedAt time.Time      `json:"completed_at"`
}

func initDB() *sql.DB {
	connStr := "user=postgres dbname=jobs password=postgres host=localhost sslmode=disable"
	db, err := sql.Open("postgres", connStr)
	if err != nil {
		log.Fatal(err)
	}

	// Create tables
	createJobsTable := `
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
	);`

	createJobRunsTable := `
	CREATE TABLE IF NOT EXISTS job_runs (
		id VARCHAR(36) PRIMARY KEY,
		job_id VARCHAR(36) NOT NULL,
		status VARCHAR(50) NOT NULL,
		started_at TIMESTAMP WITH TIME ZONE NOT NULL,
		completed TIMESTAMP WITH TIME ZONE,
		result TEXT,
		FOREIGN KEY (job_id) REFERENCES jobs(id)
	);`

	if _, err := db.Exec(createJobsTable); err != nil {
		log.Fatal(err)
	}
	if _, err := db.Exec(createJobRunsTable); err != nil {
		log.Fatal(err)
	}

	return db
}

func initRedis() *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr: "localhost:6379",
	})
}

func (js *JobService) EnqueueJob(c *gin.Context) {
	var req EnqueueRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	jobID := uuid.New().String()
	createdAt := time.Now()

	var scheduledAt *time.Time
	if req.ScheduledAt != "" {
		if t, err := time.Parse(time.RFC3339, req.ScheduledAt); err == nil {
			scheduledAt = &t
		}
	}

	maxRetries := req.MaxRetries
	if maxRetries <= 0 {
		maxRetries = 3
	}

	job := &Job{
		ID:         jobID,
		TaskType:   req.TaskType,
		Params:     req.Params,
		Status:     JobStatusEnqueued,
		CreatedAt:  createdAt,
		ScheduledAt: scheduledAt,
		MaxRetries: maxRetries,
	}

	if scheduledAt != nil && scheduledAt.After(time.Now()) {
		job.Status = JobStatusEnqueued
	} else {
		job.Status = JobStatusEnqueued
	}

	_, err := js.db.Exec(
		"INSERT INTO jobs (id, task_type, params, status, created_at, scheduled_at, max_retries) VALUES ($1, $2, $3, $4, $5, $6, $7)",
		job.ID, job.TaskType, job.Params, job.Status, job.CreatedAt, job.ScheduledAt, job.MaxRetries,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, JobResponse{
		Success: true,
		JobID:   jobID,
		Status:  job.Status,
	})
}

func (js *JobService) GetJobStatus(c *gin.Context) {
	jobID := c.Param("job_id")
	job, err := js.getJob(jobID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Job not found"})
		return
	}

	c.JSON(http.StatusOK, JobStatusResponse{
		JobID:    job.ID,
		TaskType: job.TaskType,
		Status:   job.Status,
		Progress: job.Progress,
		CreatedAt: job.CreatedAt,
		StartedAt: job.StartedAt,
		Result:   job.Result,
		NextRetryAt: job.NextRetryAt,
	})
}

func (js *JobService) ListJobs(c *gin.Context) {
	status := c.Query("status")
	taskType := c.Query("task_type")
	limit := c.Query("limit")

	query := "SELECT id, task_type, params, status, created_at, started_at, completed_at, progress, result, error, retry_count, max_retries, next_retry_at, scheduled_at FROM jobs WHERE 1=1"
	countQuery := "SELECT COUNT(*) FROM jobs WHERE 1=1"
	args := []interface{}{}
	argCount := 1

	if status != "" {
		query += fmt.Sprintf(" AND status = $%d", argCount)
		countQuery += fmt.Sprintf(" AND status = $%d", argCount)
		args = append(args, status)
		argCount++
	}

	if taskType != "" {
		query += fmt.Sprintf(" AND task_type = $%d", argCount)
		countQuery += fmt.Sprintf(" AND task_type = $%d", argCount)
		args = append(args, taskType)
		argCount++
	}

	query += fmt.Sprintf(" ORDER BY created_at DESC LIMIT $%d", argCount)
	args = append(args, limit)

	rows, err := js.db.Query(query, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	var jobs []Job
	for rows.Next() {
		job := Job{}
		var params, result sql.NullString
		var scheduledAt, nextRetryAt sql.NullTime
		err := rows.Scan(
			&job.ID, &job.TaskType, &params, &job.Status, &job.CreatedAt,
			&job.StartedAt, &job.CompletedAt, &job.Progress, &result,
			&job.Error, &job.RetryCount, &job.MaxRetries, &nextRetryAt, &scheduledAt,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if params.Valid {
			job.Params = json.RawMessage(params.String)
		}
		if result.Valid {
			job.Result = json.RawMessage(result.String)
		}
		job.NextRetryAt = nextRetryAt.Time
		job.ScheduledAt = scheduledAt.Time
		jobs = append(jobs, job)
	}

	var total int
	err = js.db.QueryRow(countQuery, args[:argCount-1]...).Scan(&total)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, ListJobsResponse{
		Jobs:  jobs,
		Total: total,
	})
}

func (js *JobService) CancelJob(c *gin.Context) {
	jobID := c.Param("job_id")
	job, err := js.getJob(jobID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Job not found"})
		return
	}

	if job.Status == JobStatusRunning || job.Status == JobStatusCompleted || job.Status == JobStatusFailed {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Cannot cancel job that has started or completed"})
		return
	}

	_, err = js.db.Exec("UPDATE jobs SET status = $1 WHERE id = $2", JobStatusCancelled, jobID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "status": "cancelled"})
}

func (js *JobService) RetryJob(c *gin.Context) {
	jobID := c.Param("job_id")
	job, err := js.getJob(jobID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Job not found"})
		return
	}

	if job.Status != JobStatusFailed {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Only failed jobs can be retried"})
		return
	}

	newJobID := uuid.New().String()
	newJob := &Job{
		ID:         newJobID,
		TaskType:   job.TaskType,
		Params:     job.Params,
		Status:     JobStatusEnqueued,
		CreatedAt:  time.Now(),
		MaxRetries: job.MaxRetries,
	}

	_, err = js.db.Exec(
		"INSERT INTO jobs (id, task_type, params, status, created_at, max_retries) VALUES ($1, $2, $3, $4, $5, $6)",
		newJob.ID, newJob.TaskType, newJob.Params, newJob.Status, newJob.CreatedAt, newJob.MaxRetries,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, JobResponse{
		Success: true,
		JobID:   newJobID,
		Status:  newJob.Status,
	})
}

func (js *JobService) GetJobResults(c *gin.Context) {
	jobID := c.Param("job_id")
	job, err := js.getJob(jobID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Job not found"})
		return
	}

	if job.Status != JobStatusCompleted {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Results only available for completed jobs"})
		return
	}

	c.JSON(http.StatusOK, ResultsResponse{
		JobID:      job.ID,
		Status:     job.Status,
		Result:     job.Result,
		CompletedAt: *job.CompletedAt,
	})
}

func (js *JobService) getJob(jobID string) (*Job, error) {
	row := js.db.QueryRow(
		"SELECT id, task_type, params, status, created_at, started_at, completed_at, progress, result, error, retry_count, max_retries, next_retry_at, scheduled_at FROM jobs WHERE id = $1",
		jobID,
	)

	job := &Job{}
	var params, result sql.NullString
	var scheduledAt, nextRetryAt sql.NullTime
	err := row.Scan(
		&job.ID, &job.TaskType, &params, &job.Status, &job.CreatedAt,
		&job.StartedAt, &job.CompletedAt, &job.Progress, &result,
		&job.Error, &job.RetryCount, &job.MaxRetries, &nextRetryAt, &scheduledAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("job not found")
	}
	if err != nil {
		return nil, err
	}
	if params.Valid {
		job.Params = json.RawMessage(params.String)
	}
	if result.Valid {
		job.Result = json.RawMessage(result.String)
	}
	job.NextRetryAt = nextRetryAt.Time
	job.ScheduledAt = scheduledAt.Time
	return job, nil
}

func (js *JobService) worker() {
	for {
		js.processNextJob()
		time.Sleep(5 * time.Second)
	}
}

func (js *JobService) processNextJob() {
	ctx := context.Background()

	// Get next job to process
	var jobID string
	err := js.redis.LPop(ctx, "job_queue").Scan(&jobID)
	if err == redis.Nil {
		return
	} else if err != nil {
		log.Printf("Error popping from queue: %v", err)
		return
	}

	job, err := js.getJob(jobID)
	if err != nil {
		log.Printf("Error getting job: %v", err)
		return
	}

	if job.Status != JobStatusEnqueued {
		return
	}

	if job.ScheduledAt != nil && job.ScheduledAt.After(time.Now()) {
		js.redis.RPush(ctx, "job_queue", jobID)
		return
	}

	js.updateJobStatus(jobID, JobStatusRunning, nil)

	jobRunID := uuid.New().String()
	_, err = js.db.Exec(
		"INSERT INTO job_runs (id, job_id, status, started_at) VALUES ($1, $2, $3, $4)",
		jobRunID, jobID, "running", time.Now(),
	)
	if err != nil {
		log.Printf("Error creating job run: %v", err)
		js.updateJobStatus(jobID, JobStatusFailed, fmt.Errorf("failed to create job run"))
		return
	}

	go js.executeJob(job, jobRunID)
}

func (js *JobService) executeJob(job *Job, jobRunID string) {
	defer func() {
		if r := recover(); r != nil {
			js.updateJobStatus(job.ID, JobStatusFailed, fmt.Errorf("panic: %v", r))
		}
	}()

	var result map[string]interface{}
	var progress string
	var err error

	switch job.TaskType {
	case "send_bulk_email":
		result, progress, err = js.sendBulkEmail(job)
	case "webhook_retry":
		result, progress, err = js.webhookRetry(job)
	case "export_generate":
		result, progress, err = js.exportGenerate(job)
	case "daily_report":
		result, progress, err = js.dailyReport(job)
	case "cleanup_old_sessions":
		result, progress, err = js.cleanupOldSessions(job)
	case "delete_user_cascade":
		result, progress, err = js.deleteUserCascade(job)
	case "sync_stripe_invoices":
		result, progress, err = js.syncStripeInvoices(job)
	case "generate_deployment_archive":
		result, progress, err = js.generateDeploymentArchive(job)
	default:
		err = fmt.Errorf("unknown task type: %s", job.TaskType)
	}

	if err != nil {
		js.handleJobError(job, jobRunID, err)
		return
	}

	js.updateJobStatus(job.ID, JobStatusCompleted, nil)
	js.updateJobRun(jobRunID, "completed", result, nil)
	js.updateJobProgress(job.ID, progress, result)
}

func (js *JobService) sendBulkEmail(job *Job) (map[string]interface{}, string, error) {
	var params struct {
		TemplateKey string `json:"template_key"`
		Filter      struct {
			TrialDaysLeft struct {
				Lte int `json:"$lte"`
			} `json:"trial_days_left"`
		} `json:"filter"`
	}

	if err := json.Unmarshal(job.Params, &params); err != nil {
		return nil, "", err
	}

	total := 500
	sent := 0
	failed := 0

	for i := 0; i < total; i++ {
		if i%10 == 0 {
			time.Sleep(10 * time.Millisecond)
		}
		if i%20 == 0 {
			failed++
		} else {
			sent++
		}

		js.updateJobProgress(job.ID, fmt.Sprintf("%d/%d", sent+failed, total), nil)
	}

	result := map[string]interface{}{
		"sent":   sent,
		"failed": failed,
		"errors": []map[string]string{
			{"user_id": "123", "error": "email_bounced"},
			{"user_id": "456", "error": "opted_out"},
		},
	}

	return result, fmt.Sprintf("%d/%d", total, total), nil
}

func (js *JobService) webhookRetry(job *Job) (map[string]interface{}, string, error) {
	result := map[string]interface{}{
		"retried": 1,
		"status":  "success",
	}

	return result, "1/1", nil
}

func (js *JobService) exportGenerate(job *Job) (map[string]interface{}, string, error) {
	result := map[string]interface{}{
		"exported_rows": 1000,
		"format":        "csv",
	}

	return result, "1/1", nil
}

func (js *JobService) dailyReport(job *Job) (map[string]interface{}, string, error) {
	result := map[string]interface{}{
		"total_users": 5000,
		"active_users": 4500,
		"new_signups": 200,
		"date": "2026-09-25",
	}

	return result, "1/1", nil
}

func (js *JobService) cleanupOldSessions(job *Job) (map[string]interface{}, string, error) {
	result := map[string]interface{}{
		"deleted_sessions": 1500,
	}

	return result, "1/1", nil
}

func (js *JobService) deleteUserCascade(job *Job) (map[string]interface{}, string, error) {
	result := map[string]interface{}{
		"deleted_user_id": "user_123",
		"deleted_sessions": 50,
		"deleted_preferences": 10,
	}

	return result, "1/1", nil
}

func (js *JobService) syncStripeInvoices(job *Job) (map[string]interface{}, string, error) {
	result := map[string]interface{}{
		"synced_invoices": 100,
		"errors": []map[string]string{
			{"invoice_id": "inv_123", "error": "not_found"},
		},
	}

	return result, "1/1", nil
}

func (js *JobService) generateDeploymentArchive(job *Job) (map[string]interface{}, string, error) {
	result := map[string]interface{}{
		"archive_size": "2.5MB",
		"files_count": 150,
	}

	return result, "1/1", nil
}

func (js *JobService) handleJobError(job *Job, jobRunID string, err error) {
	job.RetryCount++
	
	var nextRetry time.Time
	if job.RetryCount <= job.MaxRetries {
		backoff := time.Second * time.Duration(1<<uint(job.RetryCount-1))
		nextRetry = time.Now().Add(backoff)
	}

	if job.RetryCount > job.MaxRetries {
		js.updateJobStatus(job.ID, JobStatusFailed, err)
		js.updateJobRun(jobRunID, "failed", nil, err)
		return
	}

	js.updateJobStatus(job.ID, JobStatusEnqueued, nil)
	js.updateJobRun(jobRunID, "failed", nil, err)
	js.updateJobNextRetry(job.ID, nextRetry)
}

func (js *JobService) updateJobStatus(jobID string, status JobStatus, err error) {
	var errorMsg *string
	if err != nil {
		s := err.Error()
		errorMsg = &s
	}

	now := time.Now()
	query := "UPDATE jobs SET status = $1, completed_at = $2, error = $3 WHERE id = $4"
	if status == JobStatusRunning {
		query = "UPDATE jobs SET status = $1, started_at = $2 WHERE id = $3"
	}

	args := []interface{}{status, jobID}
	if status == JobStatusRunning {
		args = []interface{}{status, now, jobID}
	} else {
		args = []interface{}{status, now, errorMsg, jobID}
	}

	_, err = js.db.Exec(query, args...)
	if err != nil {
		log.Printf("Error updating job status: %v", err)
	}
}

func (js *JobService) updateJobRun(jobRunID string, status string, result interface{}, err error) {
	var resultStr string
	if result != nil {
		if b, err := json.Marshal(result); err == nil {
			resultStr = string(b)
		}
	}

	var completed *time.Time
	if status == "completed" || status == "failed" {
		t := time.Now()
		completed = &t
	}

	var errStr string
	if err != nil {
		errStr = err.Error()
	}

	_, err = js.db.Exec(
		"UPDATE job_runs SET status = $1, completed = $2, result = $3 WHERE id = $4",
		status, completed, resultStr, jobRunID,
	)
	if err != nil {
		log.Printf("Error updating job run: %v", err)
	}
}

func (js *JobService) updateJobProgress(jobID string, progress string, result interface{}) {
	var resultJSON string
	if result != nil {
		if b, err := json.Marshal(result); err == nil {
			resultJSON = string(b)
		}
	}

	_, err := js.db.Exec(
		"UPDATE jobs SET progress = $1, result = $2 WHERE id = $3",
		progress, resultJSON, jobID,
	)
	if err != nil {
		log.Printf("Error updating job progress: %v", err)
	}
}

func (js *JobService) updateJobNextRetry(jobID string, nextRetry time.Time) {
	_, err := js.db.Exec(
		"UPDATE jobs SET next_retry_at = $1 WHERE id = $2",
		nextRetry, jobID,
	)
	if err != nil {
		log.Printf("Error updating next retry: %v", err)
	}
}

func main() {
	db := initDB()
	redis := initRedis()
	js := &JobService{db: db, redis: redis}

	router := gin.Default()

	router.POST("/jobs/enqueue", js.EnqueueJob)
	router.GET("/jobs/:job_id", js.GetJobStatus)
	router.GET("/jobs", js.ListJobs)
	router.DELETE("/jobs/:job_id", js.CancelJob)
	router.POST("/jobs/:job_id/retry", js.RetryJob)
	router.GET("/jobs/:job_id/results", js.GetJobResults)

	go js.worker()

	router.Run(":8080")
}