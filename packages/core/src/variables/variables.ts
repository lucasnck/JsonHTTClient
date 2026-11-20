import type { ValidationIssue, ValidationResult } from '../contracts/types.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type VariablesFile = {
  enabled?: boolean;
  protected?: boolean;
  [key: string]: JsonValue | undefined;
};
export interface VariableSource {
  name: string;
  value: JsonValue;
  filePath: string;
  folderPath: string;
  protected: boolean;
}
export interface VariableSnapshot {
  values: ReadonlyMap<string, VariableSource>;
  scannedFiles: readonly string[];
  get(name: string): VariableSource | undefined;
}

export function isVariablesFileName(name: string): boolean {
  return (
    name === 'variables.json' || (name.endsWith('.variables.json') && name.length > '.variables.json'.length)
  );
}

/** Stable, locale-independent order: folded name, then original codepoint string. */
export function compareVariableFileNames(a: string, b: string): number {
  const fa = a.normalize('NFC').toLowerCase();
  const fb = b.normalize('NFC').toLowerCase();
  if (fa < fb) return -1;
  if (fa > fb) return 1;
  const na = a.normalize('NFC');
  const nb = b.normalize('NFC');
  return na < nb ? -1 : na > nb ? 1 : 0;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isJsonValue = (v: unknown): v is JsonValue =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v)) ||
  (Array.isArray(v) && v.every(isJsonValue)) ||
  (isRecord(v) && Object.values(v).every(isJsonValue));

export function validateVariablesFile(value: unknown): ValidationResult<VariablesFile> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value))
    return { valid: false, issues: [{ path: '/', message: 'VariablesFile deve ser objeto JSON na raiz' }] };
  for (const [key, item] of Object.entries(value)) {
    if (key === 'enabled' || key === 'protected') {
      if (typeof item !== 'boolean') issues.push({ path: `/${key}`, message: 'Metadado deve ser boolean' });
      continue;
    }
    if (['$format', 'schemaVersion', 'exclusiveGroup'].includes(key)) {
      issues.push({ path: `/${key}`, message: 'Campo legado não suportado' });
      continue;
    }
    if (key === 'variables' && Array.isArray(item) && item.some(isRecord)) {
      issues.push({
        path: `/${key}`,
        message: 'Formato legado variables[] não suportado; usar propriedades na raiz',
      });
      continue;
    }
    if (!key.trim()) {
      issues.push({ path: '/', message: 'Nome de variável vazio' });
      continue;
    }
    if (!isJsonValue(item)) {
      issues.push({ path: `/${key}`, message: 'Valor não é JSON válido' });
      continue;
    }
    // OAuth is metadata only; tokens must be obtained through a secret adapter at runtime.
    if (isRecord(item) && item.type === 'oauth2') {
      if (typeof item.issuer !== 'string' || !item.issuer.startsWith('https://'))
        issues.push({ path: `/${key}/issuer`, message: 'OAuth issuer HTTPS obrigatório' });
      if (typeof item.clientId !== 'string' || !item.clientId)
        issues.push({ path: `/${key}/clientId`, message: 'OAuth clientId obrigatório' });
      for (const k of ['accessToken', 'refreshToken', 'clientSecret'])
        if (Object.hasOwn(item, k))
          issues.push({
            path: `/${key}/${k}`,
            message: 'Credenciais OAuth não devem ser gravadas em variables.json',
          });
    }
  }
  return issues.length ? { valid: false, issues } : { valid: true, value: value as VariablesFile };
}

export function createVariableSnapshot(
  foldersNearestFirst: Array<{
    folderPath: string;
    files: Array<{ filePath: string; filename: string; content: VariablesFile }>;
  }>,
): VariableSnapshot {
  const values = new Map<string, VariableSource>();
  const scannedFiles: string[] = [];
  for (const folder of foldersNearestFirst) {
    const ordered = [...folder.files].sort((a, b) => compareVariableFileNames(a.filename, b.filename));
    for (const file of ordered) {
      if (file.content.enabled === false) continue;
      scannedFiles.push(file.filePath);
      for (const [name, value] of Object.entries(file.content)) {
        if (name === 'enabled' || name === 'protected' || value === undefined) continue;
        if (!values.has(name))
          values.set(name, {
            name,
            value,
            filePath: file.filePath,
            folderPath: folder.folderPath,
            protected: file.content.protected === true,
          });
      }
    }
  }
  return { values, scannedFiles, get: (name: string) => values.get(name) };
}

/** Files are already loaded and validated; this computes metadata changes only. */
export function planVariableFileActivation(
  files: readonly { filePath: string; filename: string; content: VariablesFile }[],
  targetFilePath: string,
  enabled: boolean,
): ReadonlyArray<{ filePath: string; content: VariablesFile; changed: boolean }> {
  if (!files.some((f) => f.filePath === targetFilePath))
    throw new Error(`Arquivo de variáveis não encontrado: ${targetFilePath}`);
  return files.map((f) => {
    const nextEnabled =
      f.filePath === targetFilePath ? enabled : enabled ? false : f.content.enabled !== false;
    const wasEnabled = f.content.enabled !== false;
    return {
      filePath: f.filePath,
      content: { ...f.content, enabled: nextEnabled },
      changed: nextEnabled !== wasEnabled,
    };
  });
}
