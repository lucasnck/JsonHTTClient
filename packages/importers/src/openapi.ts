import type { HttpRequestDefinition, NameValue, RequestFile } from '../../core/src/contracts/types.js';
import { ImportError, safeRequestFilename, uniquifyFileNames } from './import-plan.js';
import type { ImportPlan, ImportWarning, ImportedRequest } from './import-plan.js';
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
/** JSON OpenAPI 3.x subset. YAML and remote $ref require a future explicit parser/authorization. */
export function importOpenApi(source: string | unknown): ImportPlan {
  let parsed: unknown = source;
  if (typeof source === 'string') {
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      throw new ImportError(
        'UNSUPPORTED_FORMAT',
        'OpenAPI YAML não está disponível offline; fornecer JSON 3.x',
      );
    }
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.openapi !== 'string' ||
    !parsed.openapi.startsWith('3.') ||
    !isRecord(parsed.paths)
  )
    throw new ImportError('INVALID_OPENAPI', 'Esperado documento OpenAPI 3.x com paths');
  const warnings: ImportWarning[] = [],
    operations: ImportedRequest[] = [];
  const rootServers = Array.isArray(parsed.servers) ? parsed.servers : [];
  const defaultServer = rootServers[0];
  const base = isRecord(defaultServer) && typeof defaultServer.url === 'string' ? defaultServer.url : '';
  if (!base)
    warnings.push({
      code: 'MISSING_SERVER',
      message: 'OpenAPI não informa servers; requests precisam de baseUrl',
    });
  const prefix = base || '{{baseUrl}}';
  for (const [path, def] of Object.entries(parsed.paths)) {
    if (!path.startsWith('/') || !isRecord(def)) continue;
    if (Object.hasOwn(def, '$ref')) {
      warnings.push({ code: 'REF_UNRESOLVED', message: `Path ${path} usa $ref não resolvido` });
      continue;
    }
    for (const method of methods) {
      const op = def[method];
      if (!isRecord(op)) continue;
      if (Object.hasOwn(op, '$ref')) {
        warnings.push({
          code: 'REF_UNRESOLVED',
          message: `Operação ${method.toUpperCase()} ${path} usa $ref`,
        });
        continue;
      }
      const server =
        Array.isArray(op.servers) && isRecord(op.servers[0]) && typeof op.servers[0].url === 'string'
          ? op.servers[0].url
          : prefix;
      const url = server.replace(/\/$/, '') + path.replace(/\{([A-Za-z][A-Za-z0-9_-]*)\}/g, '{{$1}}');
      const req: HttpRequestDefinition = { method: method.toUpperCase(), url };
      const parameters = [
        ...(Array.isArray(def.parameters) ? def.parameters : []),
        ...(Array.isArray(op.parameters) ? op.parameters : []),
      ];
      const query: NameValue[] = [];
      for (const p of parameters) {
        if (!isRecord(p)) {
          continue;
        }
        if (Object.hasOwn(p, '$ref')) {
          warnings.push({
            code: 'REF_UNRESOLVED',
            message: `Parâmetro $ref em ${method.toUpperCase()} ${path}`,
          });
          continue;
        }
        if (p.in === 'query' && typeof p.name === 'string')
          query.push({ name: p.name, value: `{{${p.name}}}` });
      }
      if (query.length) req.query = query;
      if (Array.isArray(op.security) && op.security.length > 0) {
        req.headers = [{ name: 'Authorization', value: 'Bearer {{authorizationToken}}' }];
        warnings.push({
          code: 'AUTH_PLACEHOLDER',
          message: 'Configurar token de segurança da operação',
          operation: `${method.toUpperCase()} ${path}`,
        });
      }
      const requestBody = op.requestBody;
      if (isRecord(requestBody)) {
        if (Object.hasOwn(requestBody, '$ref'))
          warnings.push({
            code: 'REF_UNRESOLVED',
            message: `requestBody $ref em ${method.toUpperCase()} ${path}`,
          });
        else if (isRecord(requestBody.content)) {
          const jsonMedia = requestBody.content['application/json'];
          if (isRecord(jsonMedia)) {
            if (isRecord(jsonMedia.schema) && Object.hasOwn(jsonMedia.schema, 'example'))
              req.body = { type: 'json', value: jsonMedia.schema.example };
            else if (Object.hasOwn(jsonMedia, 'example'))
              req.body = { type: 'json', value: jsonMedia.example };
            else
              warnings.push({
                code: 'BODY_EXAMPLE_MISSING',
                message: `Sem exemplo de JSON para ${method.toUpperCase()} ${path}`,
              });
          }
        }
      }
      const rawName =
        typeof op.operationId === 'string' && op.operationId.trim()
          ? op.operationId
          : `${method}-${path.replaceAll('/', '-').replaceAll(/[{}]/g, '')}`;
      operations.push({
        filename: safeRequestFilename(rawName),
        file: { request: req } satisfies RequestFile,
      });
    }
  }
  if (operations.length === 0)
    throw new ImportError('INVALID_OPENAPI', 'Nenhuma operação HTTP importável encontrada');
  return { format: 'openapi', operations: uniquifyFileNames(operations), warnings };
}
