import { createHash } from "crypto";

export type Tier = "solo" | "team" | "enterprise";

export interface UsageMetricsRow {
  user_id: string;
  month: string;
  call_count: number;
  storage_bytes: number;
  updated_at: string;
}

export interface ApiCallRow {
  id: string;
  user_id: string;
  ip: string;
  endpoint: string;
  timestamp: string;
  status_code: number;
  response_time_ms: number;
}

export interface User {
  id: string;
  tier: Tier;
}

export interface QuotaLimits {
  api_calls: number;
  storage_bytes: number;
}

export interface QuotaCheckResult {
  pass: boolean;
  error?: {
    error: string;
    current?: number;
    limit?: number;
    reset_date?: string;
    reset_seconds?: number;
    usage?: number;
    tier?: string;
    minimum_tier?: string;
    upgrade_url?: string;
  };
}

export interface WhyChainEntry {
  gate: string;
  user_id: string;
  tier: Tier;
  current_usage: number;
  limit: number;
  timestamp: string;
}

export interface FeatureGateResult {
  pass: boolean;
  error?: {
    error: string;
    tier: string;
    minimum_tier: string;
    upgrade_url: string;
  };
}

export interface RateLimitResult {
  pass: boolean;
  error?: {
    error: string;
    reset_seconds: number;
  };
}

export interface QuotaService {
  checkApiCallQuota(userId: string, tier: Tier): Promise<QuotaCheckResult>;
  checkStorageQuota(userId: string, tier: Tier, incomingFileSize: number): Promise<QuotaCheckResult>;
  checkRateLimitPerUser(userId: string): Promise<RateLimitResult>;
  checkRateLimitPerIp(ip: string): Promise<RateLimitResult>;
  checkFeatureGate(userId: string, tier: Tier, feature: string): Promise<FeatureGateResult>;
  incrementUsage(userId: string, tier: Tier): Promise<void>;
  addStorage(userId: string, bytes: number): Promise<void>;
  recordApiCall(call: Omit<ApiCallRow, "id">): Promise<void>;
  getUsageMetrics(userId: string, month: string): Promise<UsageMetricsRow | null>;
  resetMonthUsage(userId: string, oldMonth: string, newMonth: string): Promise<void>;
  upgradeTier(userId: string, newTier: Tier): Promise<void>;
  getWhyChain(): WhyChainEntry[];
}

export const API_CALL_LIMITS: Record<Tier, number> = {
  solo: 1000,
  team: 10000,
  enterprise: Infinity,
};

export const STORAGE_LIMITS: Record<Tier, number> = {
  solo: 1e9,
  team: 100e9,
  enterprise: -1,
};

export const RATE_LIMIT_PER_USER = 100;
export const RATE_LIMIT_PER_IP = 10;

export const FEATURE_GATES: Record<string, Tier[]> = {
  feature_a: ["team", "enterprise"],
  feature_b: ["enterprise"],
  feature_c: ["solo", "team", "enterprise"],
};

export const UPGRADE_URLS: Record<Tier, string> = {
  solo: "https://example.com/upgrade/team",
  team: "https://example.com/upgrade/enterprise",
  enterprise: "https://example.com/upgrade/enterprise",
};

export function getCurrentMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function getResetDate(): string {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.toISOString();
}

export class InMemoryQuotaService implements QuotaService {
  private usageMetrics: Map<string, UsageMetricsRow> = new Map();
  private apiCalls: ApiCallRow[] = [];
  private users: Map<string, User> = new Map();
  private whyChain: WhyChainEntry[] = [];
  private callIdCounter: number = 0;

  private getKey(userId: string, month: string): string {
    return `${userId}:${month}`;
  }

  private logWhyChain(entry: Omit<WhyChainEntry, "timestamp">): void {
    this.whyChain.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }

  async checkApiCallQuota(userId: string, tier: Tier): Promise<QuotaCheckResult> {
    const month = getCurrentMonth();
    const key = this.getKey(userId, month);
    const currentUsage = this.usageMetrics.get(key)?.call_count ?? 0;
    const limit = API_CALL_LIMITS[tier];

    this.logWhyChain({
      gate: "api_quota_check",
      user_id: userId,
      tier,
      current_usage: currentUsage,
      limit: limit === Infinity ? -1 : limit,
    });

    if (limit === Infinity) {
      return { pass: true };
    }

    if (currentUsage + 1 <= limit) {
      return { pass: true };
    }

    return {
      pass: false,
      error: {
        error: "quota_exceeded",
        current: currentUsage,
        limit,
        reset_date: getResetDate(),
      },
    };
  }

  async checkStorageQuota(userId: string, tier: Tier, incomingFileSize: number): Promise<QuotaCheckResult> {
    const month = getCurrentMonth();
    const key = this.getKey(userId, month);
    const currentStorage = this.usageMetrics.get(key)?.storage_bytes ?? 0;
    const limit = STORAGE_LIMITS[tier];

    this.logWhyChain({
      gate: "storage_quota_check",
      user_id: userId,
      tier,
      current_usage: currentStorage,
      limit: limit === -1 ? -1 : limit,
    });

    if (limit === -1) {
      return { pass: true };
    }

    if (currentStorage + incomingFileSize <= limit) {
      return { pass: true };
    }

    return {
      pass: false,
      error: {
        error: "storage_quota_exceeded",
        current: currentStorage,
        limit,
      },
    };
  }

  async checkRateLimitPerUser(userId: string): Promise<RateLimitResult> {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const count = this.apiCalls.filter(
      (call) => call.user_id === userId && new Date(call.timestamp).getTime() > oneMinuteAgo
    ).length;

    if (count < RATE_LIMIT_PER_USER) {
      return { pass: true };
    }

    return {
      pass: false,
      error: {
        error: "rate_limit_exceeded",
        reset_seconds: 60,
      },
    };
  }

  async checkRateLimitPerIp(ip: string): Promise<RateLimitResult> {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    const count = this.apiCalls.filter(
      (call) => call.ip === ip && new Date(call.timestamp).getTime() > oneSecondAgo
    ).length;

    if (count < RATE_LIMIT_PER_IP) {
      return { pass: true };
    }

    return {
      pass: false,
      error: {
        error: "ip_rate_limit_exceeded",
        reset_seconds: 1,
      },
    };
  }

  async checkFeatureGate(userId: string, tier: Tier, feature: string): Promise<FeatureGateResult> {
    const allowedTiers = FEATURE_GATES[feature];

    if (!allowedTiers) {
      return { pass: true };
    }

    this.logWhyChain({
      gate: "feature_gate",
      user_id: userId,
      tier,
      current_usage: 0,
      limit: allowedTiers.length,
    });

    if (allowedTiers.includes(tier)) {
      return { pass: true };
    }

    const minimumTier = allowedTiers[0];
    return {
      pass: false,
      error: {
        error: "feature_not_available_in_tier",
        tier,
        minimum_tier: minimumTier,
        upgrade_url: UPGRADE_URLS[tier],
      },
    };
  }

  async incrementUsage(userId: string, tier: Tier): Promise<void> {
    const month = getCurrentMonth();
    const key = this.getKey(userId, month);
    const existing = this.usageMetrics.get(key);

    if (existing) {
      existing.call_count += 1;
      existing.updated_at = new Date().toISOString();
    } else {
      this.usageMetrics.set(key, {
        user_id: userId,
        month,
        call_count: 1,
        storage_bytes: 0,
        updated_at: new Date().toISOString(),
      });
    }
  }

  async addStorage(userId: string, bytes: number): Promise<void> {
    const month = getCurrentMonth();
    const key = this.getKey(userId, month);
    const existing = this.usageMetrics.get(key);

    if (existing) {
      existing.storage_bytes += bytes;
      existing.updated_at = new Date().toISOString();
    } else {
      this.usageMetrics.set(key, {
        user_id: userId,
        month,
        call_count: 0,
        storage_bytes: bytes,
        updated_at: new Date().toISOString(),
      });
    }
  }

  async recordApiCall(call: Omit<ApiCallRow, "id">): Promise<void> {
    this.callIdCounter += 1;
    const id = createHash("md5").update(`${this.callIdCounter}-${Date.now()}`).digest("hex");
    this.apiCalls.push({
      id,
      ...call,
    });
  }

  async getUsageMetrics(userId: string, month: string): Promise<UsageMetricsRow | null> {
    const key = this.getKey(userId, month);
    return this.usageMetrics.get(key) ?? null;
  }

  async resetMonthUsage(userId: string, oldMonth: string, newMonth: string): Promise<void> {
    const oldKey = this.getKey(userId, oldMonth);
    const newKey = this.getKey(userId, newMonth);
    const oldMetrics = this.usageMetrics.get(oldKey);

    if (oldMetrics) {
      this.usageMetrics.set(newKey, {
        user_id: userId,
        month: newMonth,
        call_count: 0,
        storage_bytes: oldMetrics.storage_bytes,
        updated_at: new Date().toISOString(),
      });
      this.usageMetrics.delete(oldKey);
    }
  }

  async upgradeTier(userId: string, newTier: Tier): Promise<void> {
    const user = this.users.get(userId);
    if (user) {
      user.tier = newTier;
    }
  }

  getWhyChain(): WhyChainEntry[] {
    return [...this.whyChain];
  }

  setUser(user: User): void {
    this.users.set(user.id, user);
  }

  getUser(userId: string): User | undefined {
    return this.users.get(userId);
  }

  clearApiCalls(): void {
    this.apiCalls = [];
  }

  clearUsage(): void {
    this.usageMetrics.clear();
  }

  clearWhyChain(): void {
    this.whyChain = [];
  }
}

export const DDL_SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_metrics (
  user_id VARCHAR(255) NOT NULL,
  month VARCHAR(7) NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  storage_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, month)
);

CREATE TABLE IF NOT EXISTS api_calls (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  ip VARCHAR(45) NOT NULL,
  endpoint VARCHAR(500) NOT NULL,
  timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status_code INTEGER NOT NULL,
  response_time_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_calls_user_timestamp ON api_calls (user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_api_calls_ip_timestamp ON api_calls (ip, timestamp);
`;

export function createQuotaService(): InMemoryQuotaService {
  return new InMemoryQuotaService();
}