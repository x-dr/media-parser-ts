export interface TokenPair {
  access_token: string;
  access_expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  token_type: string;
  must_change_password: boolean;
}

export interface AdminUser {
  id: string;
  username: string;
  must_change_password: boolean;
}

export interface Client {
  id: string;
  name: string;
  note: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  client_id: string;
  name: string;
  masked_key: string;
  enabled: boolean;
  rate_limit_per_minute: number;
  max_concurrency: number;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  api_key?: string;
}

export type CredentialSource = 'database' | 'environment' | 'none';

export interface Credential {
  name: string;
  required: boolean;
  configured: boolean;
  source: CredentialSource;
  masked: string | null;
  updated_at: string | null;
}

export interface PlatformTest {
  platform_id?: string;
  success: boolean;
  media_types: string[];
  missing_fields: string[];
  duration_ms: number;
  error_category: string | null;
  created_at: string;
}

export interface Platform {
  id: string;
  name: string;
  enabled: boolean;
  media_types: string[];
  credentials: Credential[];
  updated_at: string;
  last_test: PlatformTest | null;
}

export interface AggregateRow {
  total: number;
  successful: number;
  average_duration_ms: number | null;
  group_id?: string | null;
}

export interface ErrorAggregate {
  error_code: string;
  total: number;
}

export interface Stats {
  aggregates: AggregateRow[];
  errors: ErrorAggregate[];
  percentiles: { p50: number | null; p95: number | null; p99: number | null };
}

export interface ParseLog {
  id: string;
  request_id: string;
  client_id: string;
  api_key_id: string;
  share_url: string;
  real_url: string | null;
  platform_id: string | null;
  request_ip: string;
  user_agent: string;
  state: string;
  http_status: number | null;
  retcode: number | null;
  success: boolean | null;
  error_code: string | null;
  duration_ms: number | null;
  created_at: string;
  expires_at: string;
  input_text?: string;
  response?: unknown;
}

export interface LogPage {
  items: ParseLog[];
  next_cursor: string | null;
}
