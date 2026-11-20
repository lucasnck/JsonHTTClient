import type { HttpRequestDefinition, NameValue, RequestBody } from '../contracts/types.js';
import type { JsonValue, VariableSnapshot, VariableSource } from '../variables/variables.js';

export type TemplateErrorCode =
  | 'MISSING_VARIABLE'
  | 'VARIABLE_CYCLE'
  | 'LIMIT_EXCEEDED'
  | 'UNTERMINATED_PLACEHOLDER'
  | 'NON_SCALAR_INTERPOLATION'
  | 'DUPLICATE_KEY'
  | 'UNSAFE_KEY'
  | 'OAUTH_ADAPTER_REQUIRED'
  | 'INVALID_TEMPLATE';

export class TemplateError extends Error {
  constructor(
    public readonly code: TemplateErrorCode,
    message: string,
    public readonly key?: string,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

export interface TemplateOptions {
  readonly maxDepth?: number;
  readonly maxBytes?: number;
  readonly locals?: Readonly<Record<string, JsonValue>>;
  /** A host-provided, already authorized credential resolver. NEVER called by the language service. */
  readonly resolveOAuth?: (name: string, config: JsonValue, source: VariableSource | undefined) => string;
}

export interface TemplateResolution {
  readonly sources: readonly VariableSource[];
  readonly usedProtectedFiles: readonly string[];
}

export const PLACEHOLDER = /\{\{\s*([A-Za-z_$][\w.$-]*)\s*\}\}/g;
const EXACT = /^\{\{\s*([A-Za-z_$][\w.$-]*)\s*\}\}$/;
const KEY = /^[A-Za-z_$][\w.$-]*$/;
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
const scalar = (value: JsonValue): boolean => value === null || typeof value !== 'object';
const jsonType = (value: JsonValue): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

export class TemplateResolver {
  private readonly maxDepth: number;
  private readonly maxBytes: number;
  private readonly locals: Readonly<Record<string, JsonValue>>;
  private readonly options: TemplateOptions;
  private readonly used = new Map<string, VariableSource>();
  private expanded = 0;

  constructor(
    private readonly snapshot: VariableSnapshot,
    options: TemplateOptions = {},
  ) {
    this.options = options;
    this.locals = options.locals ?? {};
    this.maxDepth = options.maxDepth ?? 16;
    this.maxBytes = options.maxBytes ?? 1_048_576;
    if (
      !Number.isSafeInteger(this.maxDepth) ||
      this.maxDepth < 1 ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1
    ) {
      throw new TemplateError('INVALID_TEMPLATE', 'Limites de interpolação inválidos');
    }
  }

  get report(): TemplateResolution {
    return {
      sources: [...this.used.values()],
      usedProtectedFiles: [
        ...new Set([...this.used.values()].filter((s) => s.protected).map((s) => s.filePath)),
      ],
    };
  }

  private account(value: JsonValue): void {
    this.expanded += new TextEncoder().encode(JSON.stringify(value)).length;
    if (this.expanded > this.maxBytes)
      throw new TemplateError('LIMIT_EXCEEDED', 'Limite de expansão excedido');
  }

  private variable(name: string, chain: readonly string[]): JsonValue {
    if (!KEY.test(name)) throw new TemplateError('INVALID_TEMPLATE', `Nome inválido: ${name}`, name);
    if (chain.includes(name))
      throw new TemplateError(
        'VARIABLE_CYCLE',
        `Referência circular: ${[...chain, name].join(' -> ')}`,
        name,
      );
    if (chain.length >= this.maxDepth)
      throw new TemplateError('LIMIT_EXCEEDED', 'Profundidade máxima de referências excedida', name);
    let value: JsonValue;
    let source: VariableSource | undefined;
    if (Object.hasOwn(this.locals, name)) {
      value = this.locals[name]!;
    } else {
      source = this.snapshot.get(name);
      if (!source) throw new TemplateError('MISSING_VARIABLE', `Variável não encontrada: ${name}`, name);
      this.used.set(name, source);
      value = source.value;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && value.type === 'oauth2') {
      if (!this.options.resolveOAuth) {
        throw new TemplateError('OAUTH_ADAPTER_REQUIRED', `OAuth ${name} requer adaptador autorizado`, name);
      }
      return this.options.resolveOAuth(name, value, source);
    }
    return this.expand(value, [...chain, name]);
  }

  private text(input: string, chain: readonly string[], forceString: boolean): JsonValue {
    const trimmed = input.trim();
    const exact = EXACT.exec(trimmed);
    if (exact && !forceString) return this.variable(exact[1]!, chain);

    let sawPlaceholder = false;
    const resolved = input.replace(PLACEHOLDER, (_match, name: string) => {
      sawPlaceholder = true;
      const value = this.variable(name, chain);
      if (!scalar(value)) {
        throw new TemplateError('NON_SCALAR_INTERPOLATION', `Variável ${name} não é escalar em texto`, name);
      }
      return value === null ? 'null' : String(value);
    });
    if (resolved.includes('{{') || resolved.includes('}}')) {
      throw new TemplateError('UNTERMINATED_PLACEHOLDER', 'Placeholder incompleto ou inválido');
    }
    if (sawPlaceholder) this.account(resolved);
    return resolved;
  }

  private expand(input: JsonValue, chain: readonly string[] = [], forceString = false): JsonValue {
    if (chain.length > this.maxDepth)
      throw new TemplateError('LIMIT_EXCEEDED', 'Profundidade máxima excedida');
    if (typeof input === 'string') {
      const result = this.text(input, chain, forceString);
      if (result !== input && typeof result !== 'string') this.account(result);
      return result;
    }
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map((value) => this.expand(value, chain));
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, value] of Object.entries(input)) {
      const nextKey = this.text(key, chain, true);
      if (typeof nextKey !== 'string') throw new TemplateError('INVALID_TEMPLATE', 'Chave JSON inválida');
      if (UNSAFE.has(nextKey)) throw new TemplateError('UNSAFE_KEY', `Chave insegura: ${nextKey}`);
      if (Object.hasOwn(output, nextKey))
        throw new TemplateError('DUPLICATE_KEY', `Chave duplicada após interpolação: ${nextKey}`);
      Object.defineProperty(output, nextKey, {
        value: this.expand(value, chain),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  }

  resolveValue(value: JsonValue): JsonValue {
    return this.expand(value);
  }

  resolveString(value: string): string {
    const result = this.expand(value, [], true);
    if (typeof result !== 'string')
      throw new TemplateError('INVALID_TEMPLATE', `Esperado texto; recebido ${jsonType(result)}`);
    return result;
  }
}

/** A request's HTTP strings stay strings; JSON body positions preserve native JSON types. */
export function interpolateRequest(
  request: HttpRequestDefinition,
  snapshot: VariableSnapshot,
  options: TemplateOptions = {},
): { request: HttpRequestDefinition; resolution: TemplateResolution } {
  const resolver = new TemplateResolver(snapshot, options);
  const pairs = (items: NameValue[] | undefined): NameValue[] | undefined =>
    items?.map(({ name, value }) => ({
      name: resolver.resolveString(name),
      value: resolver.resolveString(value),
    }));

  const body = (input: RequestBody | undefined): RequestBody | undefined => {
    if (!input || input.type === 'none') return input;
    switch (input.type) {
      case 'json':
        return { type: 'json', value: resolver.resolveValue(input.value as JsonValue) };
      case 'text':
        return { type: 'text', value: resolver.resolveString(input.value) };
      case 'urlencoded':
        return { type: 'urlencoded', value: pairs(input.value)! };
      case 'multipart':
        return {
          type: 'multipart',
          parts: input.parts.map((part) => ({
            name: resolver.resolveString(part.name),
            ...(part.value === undefined ? {} : { value: resolver.resolveString(part.value) }),
            ...(part.file === undefined ? {} : { file: resolver.resolveString(part.file) }),
          })),
        };
      case 'binary':
      case 'stream':
        return { type: input.type, path: resolver.resolveString(input.path) };
    }
  };
  const auth =
    request.auth === undefined || request.auth.type === 'none'
      ? request.auth
      : request.auth.type === 'bearer'
        ? { type: 'bearer' as const, token: resolver.resolveString(request.auth.token) }
        : {
            type: 'basic' as const,
            username: resolver.resolveString(request.auth.username),
            password: resolver.resolveString(request.auth.password),
          };
  const result: HttpRequestDefinition = {
    method: resolver.resolveString(request.method),
    url: resolver.resolveString(request.url),
    ...(request.headers === undefined ? {} : { headers: pairs(request.headers)! }),
    ...(request.query === undefined ? {} : { query: pairs(request.query)! }),
    ...(request.body === undefined ? {} : { body: body(request.body)! }),
    ...(request.auth === undefined ? {} : { auth }),
  };
  return { request: result, resolution: resolver.report };
}
