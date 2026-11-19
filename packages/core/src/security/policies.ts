
export type PolicyViolationCode = 'INVALID_URL' | 'BLOCKED_SCHEME' | 'BLOCKED_HOST' | 'BLOCKED_PRIVATE_NETWORK' | 'APPROVAL_REQUIRED';
export class HttpPolicyError extends Error {
  constructor(public readonly code: PolicyViolationCode, message: string) {
    super(message);
    this.name = 'HttpPolicyError';
  }
}
export interface HttpNetworkPolicy {
  readonly allowHttp?: boolean;
  /** For trusted local/test applications only; off by default. */
  readonly allowPrivateNetworks?: boolean;
  readonly allowedHosts?: readonly string[];
}
export interface ApprovalRequest {
  readonly method: string;
  readonly url: string;
  readonly protectedFiles: readonly string[];
  readonly count?: number;
  readonly destinations?: readonly string[];
}
export type ApprovalAdapter = (request: ApprovalRequest) => Promise<boolean>;

function privateIPv4(value: string): boolean {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4) return false;
  const [a,b] = octets;
  if (a === undefined || b === undefined) return true;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0);
}
export function isPrivateHostname(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(normalized)) return privateIPv4(normalized);
  if (normalized.includes(':')) {
    const lower = normalized.toLowerCase();
    if (lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
    // Treat IPv4-mapped IPv6 conservatively, including mapped private IP addresses.
    if (lower.includes('::ffff:')) return true;
  }
  return false;
}
/** Pure preflight. Node runtime additionally resolves DNS; it must not trust URL checks as DNS pinning. */
export function checkHttpTarget(input: string, policy: HttpNetworkPolicy = {}): URL {
  let url: URL;
  try {url = new URL(input);}catch {throw new HttpPolicyError('INVALID_URL','URL HTTP inválida');}
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
    throw new HttpPolicyError('BLOCKED_SCHEME','Somente URLs HTTPS são aceitas por padrão');
  }
  if (url.username || url.password) throw new HttpPolicyError('INVALID_URL','Credenciais na URL não são permitidas');
  if (policy.allowedHosts && !policy.allowedHosts.some(h=>h.toLowerCase()===url.hostname.toLowerCase())) {
    throw new HttpPolicyError('BLOCKED_HOST',`Host não está na lista permitida`);
  }
  if (!policy.allowPrivateNetworks && isPrivateHostname(url.hostname)) {
    throw new HttpPolicyError('BLOCKED_PRIVATE_NETWORK','Rede local/privada bloqueada pela política do host');
  }
  return url;
}
export async function approveProtectedExecution(
  files: readonly string[], request: Omit<ApprovalRequest, 'protectedFiles'>, adapter?: ApprovalAdapter,
): Promise<void> {
  if (files.length === 0) return;
  if (!adapter || !(await adapter({...request,protectedFiles:files}))) {
    throw new HttpPolicyError('APPROVAL_REQUIRED','A execução usa variáveis protegidas e requer aprovação do host');
  }
}
