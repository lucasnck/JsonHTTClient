/** T01 — Contract types; public JSON deliberately has no schemaVersion. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | (string & {});
export interface NameValue { name: string; value: string }
export type RequestBody =
  | { type: 'none' }
  | { type: 'json'; value: unknown }
  | { type: 'text'; value: string }
  | { type: 'urlencoded'; value: NameValue[] }
  | { type: 'multipart'; parts: Array<{ name: string; value?: string; file?: string }> }
  | { type: 'binary'; path: string }
  | { type: 'stream'; path: string };
export type RequestAuth =
  | { type: 'none' }
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string };
export interface HttpRequestDefinition {
  method: HttpMethod;
  url: string;
  headers?: NameValue[];
  query?: NameValue[];
  body?: RequestBody;
  auth?: RequestAuth;
}
export type LoopSource =
  | { kind: 'inline'; items: Record<string, unknown>[] }
  | { kind: 'file'; path: string };
export interface LoopDefinition {
  source: LoopSource;
  mode?: 'sequential';
  onError?: 'stop' | 'continue';
  maxItems?: number;
}
export interface RequestFile {
  id?: string;
  request: HttpRequestDefinition;
  loop?: LoopDefinition;
  options?: { timeoutMs?: number; maxResponseBytes?: number };
}
export interface RequestProjection {
  method: string;
  url: string;
  headers: NameValue[];
  body?: RequestBody;
}
export type ResponseBody =
  | { type: 'none' }
  | { type: 'json'; value: unknown }
  | { type: 'text'; value: string }
  | { type: 'binary'; artifactRef: string };
export interface HttpResponseProjection {
  status: number;
  statusText: string;
  headers: NameValue[];
  body: ResponseBody;
}
/** The only three permitted serialized top-level keys on a single execution. */
export interface ExecutionResult {
  request: RequestProjection;
  response: HttpResponseProjection | null;
  timings: { totalMs: number };
}
export type BatchStatus = 'succeeded' | 'partial_failed' | 'failed' | 'cancelled';
export interface BatchSummary {
  status: BatchStatus;
  total: number;
  executed: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  skipped: number;
}
export interface ExecutionBatchResult {
  summary: BatchSummary;
  timings: { totalMs: number };
  results: ExecutionResult[];
}
export interface ValidationIssue { path: string; message: string }
export type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; issues: ValidationIssue[] };
