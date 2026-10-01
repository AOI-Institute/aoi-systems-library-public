import { Pool, QueryResult } from 'pg';

interface DbClient {
  query(text: string, values?: any[]): Promise<QueryResult>;
}

export class AuditLogger {
  private db: DbClient;

  constructor(db: DbClient) {
    this.db = db;
  }

  static readonly CREATE_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS audit_log (
      id UUID PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor_id TEXT,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'service', 'api_key')),
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      old_value JSONB,
      new_value JSONB,
      why_chain_id TEXT,
      metadata JSONB
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_actor_action_resource_timestamp ON audit_log (actor_id, action, resource_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_log_resource_type_resource_id_timestamp ON audit_log (resource_type, resource_id, timestamp);
  `;

  async logMutation(input: {
    actor_id: string | number | null;
    actor_type: 'user' | 'service' | 'api_key';
    action: string;
    resource_type: string;
    resource_id: string | number;
    old_value: any;
    new_value: any;
    why_chain_id?: string | null;
    metadata?: any;
  }): Promise<{ success: true; log_id: string }> {
    const logId = this.generateUuid();
    const {
      actor_id,
      actor_type,
      action,
      resource_type,
      resource_id,
      old_value,
      new_value,
      why_chain_id = null,
      metadata = null
    } = input;

    const actorIdStr = actor_id === null ? null : String(actor_id);
    const resourceIdStr = String(resource_id);

    await this.db.query(
      `INSERT INTO audit_log (
        id, timestamp, actor_id, actor_type, action, resource_type, resource_id, old_value, new_value, why_chain_id, metadata
      ) VALUES (
        $1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10
      )`,
      [
        logId,
        actorIdStr,
        actor_type,
        action,
        resource_type,
        resourceIdStr,
        JSON.stringify(old_value),
        JSON.stringify(new_value),
        why_chain_id,
        JSON.stringify(metadata)
      ]
    );

    return { success: true, log_id: logId };
  }

  async queryLogs(params: {
    actor_id?: string | number | null;
    action?: string;
    resource_type?: string;
    limit?: number;
    offset?: number;
    date_from?: string;
    date_to?: string;
  }): Promise<{
    logs: Array<{
      id: string;
      timestamp: string;
      actor_id: string | number | null;
      action: string;
      resource_type: string;
      resource_id: string | number;
      old_value: any;
      new_value: any;
      why_chain_id: string | null;
    }>;
    total: number;
    has_more: boolean;
  }> {
    const whereConditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (params.actor_id !== undefined && params.actor_id !== null) {
      whereConditions.push(`actor_id = $${paramIndex++}`);
      values.push(String(params.actor_id));
    } else if (params.actor_id === null) {
      whereConditions.push('actor_id IS NULL');
    }

    if (params.action) {
      const actionPattern = params.action.replace(/\*/g, '%');
      whereConditions.push(`action ILIKE $${paramIndex++}`);
      values.push(actionPattern);
    }

    if (params.resource_type) {
      whereConditions.push(`resource_type = $${paramIndex++}`);
      values.push(params.resource_type);
    }

    if (params.date_from) {
      whereConditions.push(`timestamp >= $${paramIndex++}`);
      values.push(`${params.date_from} 00:00:00`);
    }

    if (params.date_to) {
      whereConditions.push(`timestamp <= $${paramIndex++}`);
      values.push(`${params.date_to} 23:59:59.999`);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const countResult = await this.db.query(
      `SELECT COUNT(*) FROM audit_log ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;

    const logsResult = await this.db.query(
      `SELECT id, timestamp, actor_id, action, resource_type, resource_id, old_value, new_value, why_chain_id
       FROM audit_log ${whereClause}
       ORDER BY timestamp DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, limit, offset]
    );

    const logs = logsResult.rows.map(row => ({
      id: row.id,
      timestamp: row.timestamp.toISOString(),
      actor_id: row.actor_id === null ? null : (isNaN(Number(row.actor_id)) ? row.actor_id : Number(row.actor_id)),
      action: row.action,
      resource_type: row.resource_type,
      resource_id: row.resource_id === null ? null : (isNaN(Number(row.resource_id)) ? row.resource_id : Number(row.resource_id)),
      old_value: row.old_value,
      new_value: row.new_value,
      why_chain_id: row.why_chain_id ?? null
    }));

    return {
      logs,
      total,
      has_more: offset + logs.length < total
    };
  }

  async replay(logId: string): Promise<{
    log_id: string;
    timestamp: string;
    resource_state_at_time: any;
    has_diverged: boolean
  }> {
    const logResult = await this.db.query(
      `SELECT id, timestamp, actor_id, action, resource_type, resource_id, old_value, new_value, why_chain_id
       FROM audit_log
       WHERE id = $1`,
      [logId]
    );

    if (logResult.rowCount === 0) {
      throw new Error(`Log not found: ${logId}`);
    }

    const log = logResult.rows[0];
    const resourceType = log.resource_type;
    const resourceId = String(log.resource_id);

    const resourceLogsResult = await this.db.query(
      `SELECT * FROM audit_log
       WHERE resource_type = $1 AND resource_id = $2
       ORDER BY timestamp ASC`,
      [resourceType, resourceId]
    );

    let stateBefore = null;
    let stateNow = null;

    for (const row of resourceLogsResult.rows) {
      if (row.id === logId) {
        break;
      }
      stateBefore = row.new_value;
    }

    for (const row of resourceLogsResult.rows) {
      stateNow = row.new_value;
    }

    const hasDiverged = stateNow !== log.new_value;

    return {
      log_id: log.id,
      timestamp: log.timestamp.toISOString(),
      resource_state_at_time: log.old_value,
      has_diverged: hasDiverged
    };
  }

  async search(params: {
    q: string;
    resource_type?: string;
    limit?: number;
  }): Promise<{
    results: Array<{
      id: string;
      timestamp: string;
      actor_id: string | number | null;
      action: string;
      resource_type: string;
      resource_id: string | number;
      old_value: any;
      new_value: any;
      why_chain_id: string | null;
    }>
  }> {
    const whereConditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    const searchTerm = `%${params.q}%`;
    whereConditions.push(`(action ILIKE $${paramIndex++} OR resource_type ILIKE $${paramIndex++})`);
    values.push(searchTerm);
    values.push(searchTerm);

    if (params.resource_type) {
      whereConditions.push(`resource_type = $${paramIndex++}`);
      values.push(params.resource_type);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const limit = params.limit ?? 50;

    const result = await this.db.query(
      `SELECT id, timestamp, actor_id, action, resource_type, resource_id, old_value, new_value, why_chain_id
       FROM audit_log ${whereClause}
       ORDER BY timestamp DESC
       LIMIT $${paramIndex++}`,
      [...values, limit]
    );

    const results = result.rows.map(row => ({
      id: row.id,
      timestamp: row.timestamp.toISOString(),
      actor_id: row.actor_id === null ? null : (isNaN(Number(row.actor_id)) ? row.actor_id : Number(row.actor_id)),
      action: row.action,
      resource_type: row.resource_type,
      resource_id: row.resource_id === null ? null : (isNaN(Number(row.resource_id)) ? row.resource_id : Number(row.resource_id)),
      old_value: row.old_value,
      new_value: row.new_value,
      why_chain_id: row.why_chain_id ?? null
    }));

    return { results };
  }

  private generateUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}