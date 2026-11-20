import type { RequestFile } from '../../core/src/contracts/types.js';

export type ImportFormat = 'curl' | 'bash' | 'openapi';
export interface ImportWarning {
  code: string;
  message: string;
  operation?: string;
}
export interface ImportedRequest {
  filename: string;
  file: RequestFile;
}
export interface ImportPlan {
  format: ImportFormat;
  operations: ImportedRequest[];
  warnings: ImportWarning[];
}
export class ImportError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_SOURCE'
      | 'UNSUPPORTED_SHELL'
      | 'UNSUPPORTED_FLAG'
      | 'INVALID_OPENAPI'
      | 'UNSUPPORTED_FORMAT'
      | 'INVALID_URL'
      | 'UNSAFE_FILENAME'
      | 'WRITE_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}
const reserved = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...'com1 com2 com3 com4 com5 com6 com7 com8 com9 lpt1 lpt2 lpt3 lpt4 lpt5 lpt6 lpt7 lpt8 lpt9'.split(' '),
]);
export function safeRequestFilename(name: string): string {
  const stem = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 95);
  if (!stem || reserved.has(stem) || stem === '.' || stem === '..')
    throw new ImportError('UNSAFE_FILENAME', 'Nome de request inseguro');
  return `${stem}.request.json`;
}
export function uniquifyFileNames(operations: ImportedRequest[]): ImportedRequest[] {
  const used = new Set<string>();
  return operations.map((op) => {
    const raw = op.filename.replace(/\.request\.json$/i, '');
    let stem = raw,
      name = op.filename,
      n = 1;
    while (used.has(name.toLowerCase())) {
      n++;
      stem = raw.slice(0, 85);
      name = safeRequestFilename(`${stem}-${n}`);
    }
    used.add(name.toLowerCase());
    return { ...op, filename: name };
  });
}
