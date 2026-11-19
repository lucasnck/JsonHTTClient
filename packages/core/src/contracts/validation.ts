import type { ExecutionBatchResult, ExecutionResult, NameValue, RequestFile, ValidationIssue, ValidationResult } from './types.js';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v);
const allowed = (o: Record<string, unknown>, keys: readonly string[], path: string, out: ValidationIssue[]) => {
  for (const key of Object.keys(o)) if (!keys.includes(key)) out.push({ path: `${path}/${key}`, message: 'Propriedade não permitida' });
};
const issue = (out: ValidationIssue[], path: string, message: string) => out.push({ path, message });
function pairs(v: unknown, path: string, out: ValidationIssue[]) {
  if (!Array.isArray(v)) { issue(out, path, 'Esperado array de {name,value}'); return; }
  v.forEach((x, i) => {
    const p = `${path}/${i}`;
    if (!isObject(x)) return issue(out, p, 'Esperado objeto');
    allowed(x, ['name','value'], p, out);
    if (typeof x.name !== 'string' || !x.name.trim()) issue(out, `${p}/name`, 'name deve ser string não vazia');
    if (typeof x.value !== 'string') issue(out, `${p}/value`, 'value deve ser string');
  });
}
function validateBody(v: unknown, path: string, out: ValidationIssue[]) {
  if (!isObject(v) || typeof v.type !== 'string') return issue(out, path, 'body deve ter type');
  if (v.type === 'none') return allowed(v, ['type'], path, out);
  if (v.type === 'json') { allowed(v, ['type','value'], path, out); if (!Object.hasOwn(v,'value')) issue(out, `${path}/value`, 'value obrigatório'); return; }
  if (v.type === 'text') { allowed(v, ['type','value'], path, out); if (typeof v.value !== 'string') issue(out, `${path}/value`, 'Esperado texto'); return; }
  if (v.type === 'urlencoded') { allowed(v, ['type','value'], path, out); return pairs(v.value, `${path}/value`, out); }
  if (v.type === 'multipart') {
    allowed(v, ['type','parts'], path, out);
    if (!Array.isArray(v.parts)) return issue(out, `${path}/parts`, 'Esperado array');
    for (const [i, p] of v.parts.entries()) {
      if (!isObject(p)) {issue(out, `${path}/parts/${i}`, 'Esperado objeto');continue;}
      allowed(p, ['name','value','file'], `${path}/parts/${i}`, out);
      if (typeof p.name !== 'string' || !p.name) issue(out, `${path}/parts/${i}/name`, 'name obrigatório');
      if ((typeof p.value !== 'string') === (typeof p.file !== 'string')) issue(out, `${path}/parts/${i}`, 'Definir value OU file');
    }
    return;
  }
  if (v.type === 'binary' || v.type === 'stream') {
    allowed(v, ['type','path'], path, out);
    if (typeof v.path !== 'string' || !v.path.trim()) issue(out, `${path}/path`, 'path obrigatório');
    return;
  }
  issue(out, `${path}/type`, 'Tipo de body desconhecido');
}
function validateLoop(v: unknown, out: ValidationIssue[]) {
  if (!isObject(v)) return issue(out, '/loop', 'Esperado objeto');
  allowed(v, ['source','mode','onError','maxItems'], '/loop', out);
  if (v.mode !== undefined && v.mode !== 'sequential') issue(out, '/loop/mode', 'Somente sequential suportado');
  if (v.onError !== undefined && !['stop','continue'].includes(String(v.onError))) issue(out, '/loop/onError', 'Valor inválido');
  if (v.maxItems !== undefined && (!isInt(v.maxItems) || Number(v.maxItems) < 1)) issue(out, '/loop/maxItems', 'Inteiro positivo obrigatório');
  const s=v.source;
  if (!isObject(s)) return issue(out, '/loop/source', 'Esperado objeto');
  if (s.kind === 'inline') {
    allowed(s, ['kind','items'], '/loop/source', out);
    if (!Array.isArray(s.items)) return issue(out, '/loop/source/items', 'Array obrigatório');
    s.items.forEach((item, i) => {if (!isObject(item)) issue(out, `/loop/source/items/${i}`, 'Cada item deve ser objeto JSON');});
  } else if (s.kind === 'file') {
    allowed(s, ['kind','path'], '/loop/source', out);
    if (typeof s.path !== 'string' || !s.path.trim()) issue(out, '/loop/source/path', 'Caminho obrigatório');
  } else issue(out, '/loop/source/kind', 'Somente inline/file');
}

/** Validates the canonical authored structure; ignores no legacy metadata. */
export function validateRequestFile(value: unknown, fileName: string): ValidationResult<RequestFile> {
  const issues: ValidationIssue[] = [];
  if (!fileName.endsWith('.request.json') || fileName === '.request.json')
    issue(issues, '/', 'Apenas arquivos *.request.json podem ser executados');
  if (!isObject(value)) {
    issue(issues,'/', 'Root deve ser objeto JSON');
    return {valid:false,issues};
  }
  allowed(value, ['request','id','loop','options'], '', issues);
  if (value.id !== undefined && typeof value.id !== 'string') issue(issues, '/id', 'id deve ser string');
  if (!isObject(value.request)) issue(issues,'/request', 'request deve ser objeto');
  else {
    const r=value.request;
    allowed(r, ['method','url','headers','query','body','auth'], '/request', issues);
    if (typeof r.method !== 'string' || !/^[A-Z][A-Z0-9-]*$/.test(r.method)) issue(issues, '/request/method', 'method HTTP inválido');
    if (typeof r.url !== 'string' || !r.url.trim()) issue(issues, '/request/url', 'url obrigatório');
    if (r.headers !== undefined) pairs(r.headers, '/request/headers', issues);
    if (r.query !== undefined) pairs(r.query, '/request/query', issues);
    if (r.body !== undefined) validateBody(r.body, '/request/body', issues);
    if (r.auth !== undefined) {
      const a=r.auth;
      if (!isObject(a)) issue(issues, '/request/auth', 'auth deve ser objeto');
      else if (a.type === 'none') allowed(a, ['type'], '/request/auth', issues);
      else if (a.type === 'basic') {
        allowed(a, ['type','username','password'], '/request/auth', issues);
        if (typeof a.username !== 'string' || typeof a.password !== 'string') issue(issues,'/request/auth','basic requer username/password strings');
      } else if (a.type === 'bearer') {
        allowed(a, ['type','token'], '/request/auth', issues);
        if (typeof a.token !== 'string') issue(issues,'/request/auth/token','bearer requer token string');
      } else issue(issues,'/request/auth/type','Tipo de auth inválido');
    }
  }
  if (value.loop !== undefined) validateLoop(value.loop, issues);
  if (value.options !== undefined) {
    if (!isObject(value.options)) issue(issues,'/options','options deve ser objeto');
    else {
      allowed(value.options, ['timeoutMs','maxResponseBytes'], '/options', issues);
      for (const key of ['timeoutMs','maxResponseBytes'])
        if (value.options[key] !== undefined && (!isInt(value.options[key]) || Number(value.options[key]) <= 0)) issue(issues,`/options/${key}`,'Inteiro positivo obrigatório');
    }
  }
  return issues.length ? {valid:false,issues} : {valid:true,value:value as unknown as RequestFile};
}

export function validateExecutionResult(value: unknown): ValidationResult<ExecutionResult> {
  const issues: ValidationIssue[]=[];
  if (!isObject(value)) return {valid:false,issues:[{path:'/',message:'Root objeto obrigatório'}]};
  allowed(value, ['request','response','timings'], '', issues);
  if (!isObject(value.request)) issue(issues,'/request','request obrigatória');
  else {
    allowed(value.request,['method','url','headers','body'],'/request',issues);
    if (typeof value.request.method!=='string' || typeof value.request.url!=='string') issue(issues,'/request','method e url obrigatórios');
    pairs(value.request.headers, '/request/headers', issues);
  }
  if (value.response !== null) {
    if (!isObject(value.response)) issue(issues,'/response','response deve ser objeto ou null');
    else {
      allowed(value.response,['status','statusText','headers','body'],'/response',issues);
      if (!isInt(value.response.status) || Number(value.response.status)<100 || Number(value.response.status)>599) issue(issues,'/response/status','HTTP status 100..599 obrigatório');
      if (typeof value.response.statusText!=='string') issue(issues,'/response/statusText','statusText obrigatório');
      pairs(value.response.headers, '/response/headers', issues);
      const b=value.response.body;
      if (!isObject(b) || !['none','json','text','binary'].includes(String(b.type))) issue(issues,'/response/body','body tipado obrigatório');
    }
  }
  if (!isObject(value.timings) || !Number.isFinite(value.timings.totalMs) || Number(value.timings.totalMs)<0) issue(issues,'/timings/totalMs','totalMs >= 0');
  else allowed(value.timings,['totalMs'],'/timings',issues);
  return issues.length?{valid:false,issues}:{valid:true,value:value as unknown as ExecutionResult};
}

export function validateExecutionBatchResult(value: unknown): ValidationResult<ExecutionBatchResult> {
  const issues: ValidationIssue[]=[];
  if (!isObject(value)) return {valid:false,issues:[{path:'/',message:'Root objeto obrigatório'}]};
  allowed(value,['summary','timings','results'],'',issues);
  if (!isObject(value.summary)) issue(issues,'/summary','Resumo obrigatório');
  else {
    allowed(value.summary,['status','total','executed','succeeded','failed','cancelled','skipped'],'/summary',issues);
    if (!['succeeded','partial_failed','failed','cancelled'].includes(String(value.summary.status))) issue(issues,'/summary/status','Status inválido');
    for (const n of ['total','executed','succeeded','failed','cancelled','skipped'])
      if (!isInt(value.summary[n]) || Number(value.summary[n])<0) issue(issues,`/summary/${n}`,'Contador inteiro >= 0 obrigatório');
    if (['total','executed','succeeded','failed','cancelled','skipped'].every(k=>isInt((value.summary as Record<string, unknown>)[k]))) {
      if (value.summary.total !== Number(value.summary.executed)+Number(value.summary.skipped)) issue(issues,'/summary','total = executed + skipped');
      if (value.summary.executed !== Number(value.summary.succeeded)+Number(value.summary.failed)+Number(value.summary.cancelled)) issue(issues,'/summary','executed = succeeded+failed+cancelled');
    }
  }
  if (!isObject(value.timings)|| !Number.isFinite(value.timings.totalMs)|| Number(value.timings.totalMs)<0) issue(issues,'/timings/totalMs','totalMs >= 0');
  else allowed(value.timings,['totalMs'],'/timings',issues);
  if (!Array.isArray(value.results)) issue(issues,'/results','Array obrigatório');
  else value.results.forEach((r,i)=>{const v=validateExecutionResult(r);if(!v.valid) for(const e of v.issues) issue(issues,`/results/${i}${e.path}`,e.message);});
  return issues.length?{valid:false,issues}:{valid:true,value:value as unknown as ExecutionBatchResult};
}

export function normalizeRequestHeaders(headers?: NameValue[]): NameValue[] { return headers?.map(({name,value})=>({name,value})) ?? []; }
