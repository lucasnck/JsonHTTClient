import type {
  HttpRequestDefinition,
  NameValue,
  RequestFile,
  RequestBody,
} from '../../core/src/contracts/types.js';
import { ImportError, safeRequestFilename, uniquifyFileNames } from './import-plan.js';
import type { ImportPlan, ImportWarning } from './import-plan.js';

/** Shell-like tokenizer WITHOUT interpolation, process spawning or shell execution. */
function shellTokens(input: string): string[] {
  const tokens: string[] = [];
  let token = '',
    quote: '' | "'" | '"' = '',
    hasToken = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (!quote && /\s/.test(c)) {
      if (hasToken) {
        tokens.push(token);
        token = '';
        hasToken = false;
      }
      continue;
    }
    if (c === '\\' && quote !== "'") {
      const next = input[i + 1];
      if (next === undefined) throw new ImportError('UNSUPPORTED_SHELL', 'Escape final incompleto');
      if (next === '\n') {
        i++;
        continue;
      }
      if (next === '\r' && input[i + 2] === '\n') {
        i += 2;
        continue;
      }
      token += next;
      i++;
      hasToken = true;
      continue;
    }
    if (c === "'" && quote !== '"') {
      quote = quote === "'" ? '' : "'";
      hasToken = true;
      continue;
    }
    if (c === '"' && quote !== "'") {
      quote = quote === '"' ? '' : '"';
      hasToken = true;
      continue;
    }
    if (quote !== "'" && (c === '$' || c === '`'))
      throw new ImportError('UNSUPPORTED_SHELL', 'Expansão/execução de shell não é suportada');
    if (!quote && ';&|<>'.includes(c))
      throw new ImportError('UNSUPPORTED_SHELL', 'Operadores de shell não são suportados');
    token += c;
    hasToken = true;
  }
  if (quote) throw new ImportError('UNSUPPORTED_SHELL', 'Aspas não fechadas');
  if (hasToken) tokens.push(token);
  return tokens;
}
function normalizedUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ImportError('INVALID_URL', 'URL de cURL inválida');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new ImportError('INVALID_URL', 'cURL requer HTTP(S) sem credenciais na URL');
  return url;
}
function credentialPlaceholder(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower === 'authorization') return '{{authorizationToken}}';
  if (lower === 'cookie') return '{{cookie}}';
  if (lower === 'x-api-key') return '{{apiKey}}';
  return undefined;
}
function oneCurl(
  source: string,
  index: number,
): { filename: string; file: RequestFile; warnings: ImportWarning[] } {
  const parts = shellTokens(source);
  if (parts[0] !== 'curl')
    throw new ImportError('UNSUPPORTED_SHELL', 'Importação estática aceita somente comandos curl');
  let method = '',
    url = '',
    head = false,
    getQuery = false,
    rawBody: string | undefined,
    user: string | undefined;
  const headers: NameValue[] = [],
    forms: NameValue[] = [],
    urlencoded: NameValue[] = [],
    warnings: ImportWarning[] = [];
  const flagsWithValue = new Set([
    '-X',
    '--request',
    '-H',
    '--header',
    '-d',
    '--data',
    '--data-raw',
    '--data-ascii',
    '--data-urlencode',
    '--url',
    '-u',
    '--user',
    '-F',
    '--form',
  ]);
  const noOp = new Set(['-s', '--silent', '-S', '--show-error', '-L', '--location', '--compressed']);
  for (let i = 1; i < parts.length; i++) {
    let arg = parts[i]!;
    if (noOp.has(arg)) {
      if (arg === '-L' || arg === '--location')
        warnings.push({
          code: 'REDIRECT_POLICY',
          message: 'Redirecionamento será controlado pela política HTTP do host',
        });
      continue;
    }
    if (arg === '-I' || arg === '--head') {
      head = true;
      continue;
    }
    if (arg === '-G' || arg === '--get') {
      getQuery = true;
      continue;
    }
    let value: string | undefined;
    if (arg.startsWith('--') && arg.includes('=')) {
      const k = arg.slice(0, arg.indexOf('='));
      if (flagsWithValue.has(k)) {
        value = arg.slice(arg.indexOf('=') + 1);
        arg = k;
      }
    } else if (/^-[XHduF]/.test(arg) && arg.length > 2 && flagsWithValue.has(arg.slice(0, 2))) {
      value = arg.slice(2);
      arg = arg.slice(0, 2);
    }
    if (flagsWithValue.has(arg)) {
      value ??= parts[++i];
      if (value === undefined) throw new ImportError('INVALID_SOURCE', `Valor ausente para ${arg}`);
      if (arg === '-X' || arg === '--request') {
        method = value.toUpperCase();
        continue;
      }
      if (arg === '--url') {
        url = value;
        continue;
      }
      if (arg === '-u' || arg === '--user') {
        user = value;
        continue;
      }
      if (arg === '-H' || arg === '--header') {
        const pos = value.indexOf(':');
        if (pos < 1) throw new ImportError('INVALID_SOURCE', 'Header precisa de name: value');
        const name = value.slice(0, pos).trim(),
          plain = value.slice(pos + 1).trim();
        const secret = credentialPlaceholder(name);
        if (secret) {
          headers.push({ name, value: secret });
          warnings.push({
            code: 'CREDENTIAL_REPLACED',
            message: `Header ${name} usa variável placeholder em vez de segredo original`,
          });
        } else headers.push({ name, value: plain });
        continue;
      }
      if (arg === '-F' || arg === '--form') {
        const sep = value.indexOf('=');
        if (sep < 1) throw new ImportError('INVALID_SOURCE', 'Form deve ser name=value');
        const part = value.slice(sep + 1);
        if (part.startsWith('@'))
          throw new ImportError(
            'UNSUPPORTED_FLAG',
            'Upload de arquivo local precisa ser configurado manualmente',
          );
        forms.push({ name: value.slice(0, sep), value: part });
        continue;
      }
      if (arg === '--data-urlencode') {
        const sep = value.indexOf('=');
        if (sep < 1) throw new ImportError('INVALID_SOURCE', 'data-urlencode requer name=value');
        urlencoded.push({ name: value.slice(0, sep), value: value.slice(sep + 1) });
        continue;
      }
      if (value.startsWith('@'))
        throw new ImportError('UNSUPPORTED_FLAG', '@file e upload local não são importados automaticamente');
      rawBody = rawBody === undefined ? value : `${rawBody}&${value}`;
      continue;
    }
    if (arg.startsWith('-')) throw new ImportError('UNSUPPORTED_FLAG', `Flag cURL não suportada: ${arg}`);
    if (url) throw new ImportError('INVALID_SOURCE', 'Somente uma URL por comando cURL');
    url = arg;
  }
  const target = normalizedUrl(url);
  if (user) {
    const pos = user.indexOf(':');
    const username = pos >= 0 ? user.slice(0, pos) : user;
    warnings.push({
      code: 'CREDENTIAL_REPLACED',
      message: 'Senha Basic Auth substituída por {{basicPassword}}',
    });
    headers.push({ name: 'Authorization', value: 'Basic {{basicAuthorization}}' });
    // Basic credentials cannot safely be calculated at import time. Host supplies encoded value.
    warnings.push({
      code: 'BASIC_AUTH_REQUIRES_CONFIG',
      message: `Configurar Basic Auth para usuário ${username} no arquivo de variáveis`,
    });
  }
  const query: NameValue[] = [];
  if (getQuery) {
    if (rawBody) {
      for (const pair of rawBody.split('&')) {
        const pos = pair.indexOf('=');
        query.push({ name: pos < 0 ? pair : pair.slice(0, pos), value: pos < 0 ? '' : pair.slice(pos + 1) });
      }
    }
    query.push(...urlencoded);
  }
  let body: RequestBody | undefined;
  if (forms.length) {
    body = { type: 'multipart', parts: forms.map((p) => ({ name: p.name, value: p.value })) };
  } else if (!getQuery && urlencoded.length) {
    body = { type: 'urlencoded', value: urlencoded };
  } else if (!getQuery && rawBody !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) body = { type: 'json', value: parsed };
    else body = { type: 'text', value: rawBody };
  }
  const upper = method || (head ? 'HEAD' : body ? 'POST' : 'GET');
  const request: HttpRequestDefinition = {
    method: upper,
    url: target.href,
    ...(headers.length ? { headers } : {}),
    ...(query.length ? { query } : {}),
    ...(body ? { body } : {}),
  };
  const name = safeRequestFilename(
    `${upper}-${target.pathname === '/' ? 'root' : target.pathname.replaceAll('/', '-')}-${index || ''}`,
  );
  return { filename: name, file: { request }, warnings };
}
export function importCurl(source: string, format: 'curl' | 'bash' = 'curl'): ImportPlan {
  if (source.length > 1024 * 1024)
    throw new ImportError('INVALID_SOURCE', 'Comando de importação excede tamanho permitido');
  const normalized = source.replace(/\\\r?\n/g, ' ');
  let commands: string[];
  if (format === 'bash') {
    commands = normalized
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
    if (commands.length === 0) throw new ImportError('INVALID_SOURCE', 'Bash não contém curl');
    if (commands.some((c) => !c.startsWith('curl ')))
      throw new ImportError(
        'UNSUPPORTED_SHELL',
        'Bash suporta apenas linhas curl estáticas, sem scripts/variáveis',
      );
  } else commands = [normalized.trim()];
  const data = commands.map((command, i) => oneCurl(command, i));
  return {
    format,
    operations: uniquifyFileNames(data.map(({ filename, file }) => ({ filename, file }))),
    warnings: data.flatMap((x) => x.warnings),
  };
}
