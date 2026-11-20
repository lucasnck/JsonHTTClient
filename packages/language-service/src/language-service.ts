import { PLACEHOLDER, TemplateError, TemplateResolver } from '../../core/src/templates/interpolation.js';
import type { VariableSnapshot } from '../../core/src/variables/variables.js';
import type { JsonValue } from '../../core/src/variables/variables.js';

export interface PlaceholderSpan {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}
export interface VariableHover {
  readonly name: string;
  readonly type: string;
  readonly origin: string;
  readonly protected: boolean;
  readonly preview: string;
}
export interface Completion {
  readonly label: string;
  readonly kind: 'variable' | 'property';
  readonly detail: string;
}
export interface LanguageDiagnostic {
  readonly start: number;
  readonly end: number;
  readonly code: string;
  readonly message: string;
}

export function findPlaceholders(text: string): PlaceholderSpan[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => ({
    name: match[1]!,
    start: match.index,
    end: match.index + match[0].length,
  }));
}

const preview = (value: JsonValue): string => {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && value.type === 'oauth2') {
    const issuer = typeof value.issuer === 'string' ? value.issuer : '(issuer não definido)';
    const client = typeof value.clientId === 'string' ? value.clientId : '(clientId não definido)';
    return `OAuth2 — issuer: ${issuer}; clientId: ${client}`;
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ('secretRef' in value || value.type === 'secret')
  ) {
    return '[REFERÊNCIA PROTEGIDA]';
  }
  const encoded = JSON.stringify(value);
  return encoded.length > 180 ? `${encoded.slice(0, 177)}...` : encoded;
};

/** Does not invoke OAuth token resolution, IO or a network request. */
export function hoverVariable(name: string, snapshot: VariableSnapshot): VariableHover | undefined {
  const source = snapshot.get(name);
  if (!source) return undefined;
  const type =
    source.value === null
      ? 'null'
      : Array.isArray(source.value)
        ? 'array'
        : typeof source.value === 'object' && source.value.type === 'oauth2'
          ? 'oauth2'
          : typeof source.value;
  // For simple cross-references use the SAME resolver as runtime, without materializing OAuth credentials.
  let display: string;
  if (
    type === 'oauth2' ||
    (typeof source.value === 'object' &&
      source.value !== null &&
      !Array.isArray(source.value) &&
      'secretRef' in source.value)
  ) {
    display = preview(source.value);
  } else {
    try {
      display = preview(new TemplateResolver(snapshot).resolveValue(source.value));
    } catch (error) {
      display =
        error instanceof TemplateError && error.code === 'OAUTH_ADAPTER_REQUIRED'
          ? '[REQUER TOKEN EM EXECUÇÃO]'
          : `[${error instanceof Error ? error.message : 'Erro ao resolver'}]`;
    }
  }
  return { name, type, origin: source.filePath, protected: source.protected, preview: display };
}

const STATIC_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  root: ['request', 'id', 'loop', 'options'],
  request: ['method', 'url', 'headers', 'query', 'body', 'auth'],
  options: ['timeoutMs', 'maxResponseBytes'],
  loop: ['source', 'mode', 'onError', 'maxItems'],
  body: ['type', 'value', 'parts', 'path'],
};

/** Safe, partial-document suggestions; a complete JSON Schema engine is a separate adapter. */
export function completeAt(
  text: string,
  offset: number,
  fileName: string,
  snapshot: VariableSnapshot,
): Completion[] {
  if (!(
    fileName.endsWith('.request.json') ||
    fileName === 'variables.json' ||
    fileName.endsWith('.variables.json')
  ))
    return [];
  const before = text.slice(0, offset);
  const marker = before.lastIndexOf('{{');
  if (marker >= 0 && before.indexOf('}}', marker) === -1) {
    const typed = before
      .slice(marker + 2)
      .trimStart()
      .toLowerCase();
    return [...snapshot.values.keys()]
      .filter((name) => name.toLowerCase().startsWith(typed))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ label: name, kind: 'variable', detail: snapshot.get(name)!.filePath }));
  }
  if (!fileName.endsWith('.request.json')) return [];
  // Static fallback usable on incomplete drafts; authoritative object completion is JSON Schema.
  const scope = [...before.matchAll(/"(request|options|loop|body)"\s*:\s*\{/g)].at(-1)?.[1] ?? 'root';
  return (STATIC_PROPERTIES[scope] ?? []).map((label) => ({
    label,
    kind: 'property' as const,
    detail: `JSON field: ${scope}`,
  }));
}

export function diagnosePlaceholders(
  text: string,
  fileName: string,
  snapshot: VariableSnapshot,
): LanguageDiagnostic[] {
  if (!(
    fileName.endsWith('.request.json') ||
    fileName === 'variables.json' ||
    fileName.endsWith('.variables.json')
  ))
    return [];
  return findPlaceholders(text)
    .filter((span) => !snapshot.get(span.name))
    .map((span) => ({
      start: span.start,
      end: span.end,
      code: 'UNDEFINED_VARIABLE',
      message: `Variável não encontrada: ${span.name}`,
    }));
}
