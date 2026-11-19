# JsonHttpEngineWorkspace — TypeScript HTTP Engine

Implementação incremental do motor HTTP declarativo especificado em Google Drive. O código-fonte do motor é compartilhado entre os clientes e terá distribuição npm/CDN e bundles independentes, conforme a ADR-001. **Não há publicação npm, CDN, VSIX, MCP server ou Desktop instalável nesta entrega.**

## Implementado no código

- **T01 (parcial):** tipos TypeScript de RequestFile, Response individual e batch, validação inicial e JSON Schemas Draft 2020-12.
- **T02 (parcial):** arquivos `variables.json` e `*.variables.json`, `enabled`/`protected` por arquivo, herança física, precedência alfabética de múltiplos arquivos ativos, origem de cada variável e Activate/Deactivate.
- **T03 (parcial):** interpolação `{{name}}` em URL, headers, query, autenticação e body; tipos JSON preservados em placeholder completo; resolução recursiva, limites, detecção de ciclo/colisão/chaves inseguras, overrides de foreach; hover/completion/diagnósticos básicos e metadata OAuth sem login.
- **T04 (parcial):** cliente HTTP Node fetch, JSON/text/urlencoded/multipart textual, HTTP 4xx/5xx como Response real, headers de request/response normalizados, mascaramento de headers conhecidos, sessão temporária para revelar originais sem rerun, redirects revalidados e limites de timeout/tamanho.
- **T05 (parcial):** loop sequencial inline ou dataset JSON autorizado, `onError`, AbortSignal/Stop, eventos de progresso, batch `{summary,timings,results[]}`, preflight de variáveis e autorização protected antes do primeiro HTTP.
- **T06 (parcial):** OAuth2/OIDC metadata discovery read-only (well-known OIDC e RFC 8414), metadados validados e limitados em tamanho, definição `OAuthToken` gravada SOMENTE no `variables.json` ou `*.variables.json` escolhido, sem guardar access/refresh tokens. Código + PKCE S256, state e troca de code em endpoint HTTPS usando um CredentialVault fornecido pelo host. A autenticação visual/loopback/vault real e refresh são ainda pendentes.
- **T07 (parcial):** importadores estáticos de cURL e Bash (sem executar shell), OpenAPI 3.x **JSON**, preview sem efeitos e Apply explícito em diretório autorizado sem overwrite; headers de autenticação importados são substituídos por placeholders. OpenAPI YAML, refs remotos e recursos avançados ainda pendentes.
- **F02 (parcial):** CLI agora aceita `oauth discover`, `oauth save`, `import curl|bash|openapi` (preview por padrão e `--apply` explícito) e `variables activate|deactivate`; não realiza login OAuth automaticamente.
- **T09 (parcial):** checagem de esquema/hosts e endereços locais, aprovação explícita de variáveis protegidas, controle básico de destinos HTTP. **Não é SSRF-hardening completo** (DNS pinning, acesso cross-process, races e outras políticas pendentes).
- **F01 (parcial):** CLI inicial `run`, `list`, `variables explain`, suporte a loop/Stop via signal, JSON canônico em stdout e progresso/diagnósticos em stderr. `run-dir` e recursos avançados ainda não estão implementados.
- **T08 (parcial):** entrada browser-safe pura (`packages/sdk-js/src/index.browser.ts`) sem APIs Node; adaptador HTTP browser/CDN bundle/npm publish ainda não feitos.
- **T11 (parcial):** TypeScript estrito, ESLint 9 flat config, Prettier, EditorConfig e comandos de qualidade configurados. Ainda é necessário instalar/rodar os plugins ESLint e Prettier reais e gerar lockfile.

## Exemplo de uso da CLI (Node.js 22+)

O código deve ser compilado antes de rodar:

```bash
npm install # requer acesso ao registro npm; gera lockfile
npm run build
node dist/apps/cli/src/main.js --help
```

Um projeto de exemplo:

```text
workspace/
  variables.json
  customers/
    dev.variables.json
    prod.variables.json
    list.request.json
```

`customers/dev.variables.json`:

```json
{
  "enabled": true,
  "protected": false,
  "baseUrl": "https://api.example.com"
}
```

`customers/list.request.json`:

```json
{
  "request": {
    "method": "GET",
    "url": "{{baseUrl}}/customers",
    "headers": [{"name": "Accept", "value": "application/json"}]
  }
}
```

```bash
node dist/apps/cli/src/main.js run ./workspace/customers/list.request.json --root ./workspace
node dist/apps/cli/src/main.js list ./workspace/customers
node dist/apps/cli/src/main.js variables explain ./workspace/customers/list.request.json --root ./workspace --name baseUrl
```

HTTP não criptografado e redes privadas são **bloqueados por padrão**. Para testes explícitos com um servidor local confiável, acrescentar `--allow-http --allow-private-network`. `--allow-protected` autoriza a execução quando variáveis efetivas vierem de arquivos com `protected:true`. `--show-sensitive` é opt-in para exibir headers reais da execução na saída padrão. Não envie outputs desse modo para logs compartilhados.


### OAuth, importação e ativação (funcionalidades parciais F02)

```bash
# Discovery não faz login e não grava arquivos:
node dist/apps/cli/src/main.js oauth discover https://identity.example.com/tenant

# Configuração OAuth em arquivo EXATO escolhido pelo usuário, sem token salvo:
node dist/apps/cli/src/main.js oauth save --issuer https://identity.example.com/tenant \
  --file ./workspace/customers/dev.variables.json --name OAuthToken \
  --client-id your-client-id --scopes customers.read --root ./workspace

# Preview estático: não executa cURL/Bash nem envia request HTTP:
node dist/apps/cli/src/main.js import curl --file ./workspace/request.curl --root ./workspace

# Gerar *.request.json após ação explícita e em pasta autorizada:
node dist/apps/cli/src/main.js import curl --file ./workspace/request.curl \
  --root ./workspace --apply --output-dir ./workspace/customers

# Ativação pelo motor desliga outros arquivos de variáveis da mesma pasta:
node dist/apps/cli/src/main.js variables activate ./workspace/customers/dev.variables.json --root ./workspace
```

`import openapi` suporta JSON 3.x nesta etapa, não YAML. Tokens OAuth são enviados apenas a um `OAuthCredentialVault` que deverá ser implementado pelo host; nenhuma integração automática ao editor, navegador ou CLI existe ainda.

## Qualidade

```bash
npm run format       # Prettier --write (ainda não validado neste ambiente)
npm run check        # Prettier check + ESLint + TypeScript + testes
npm run check:offline # apenas TypeScript + testes, NÃO substitui npm run check
```

No ambiente de desenvolvimento desta entrega, `npm run check:offline` validou TypeScript e **95/95 testes** (contratos, variáveis, HTTP local, loops, OAuth config/discovery/PKCE, importadores, CLI e boundary browser). ESLint/Prettier reais e CI continuam **NOT_RUN/BLOCKED** por falta de dependências acessíveis no registry. Não há lockfile. Nenhuma spec foi marcada `DONE` apenas por esses resultados.

## Limitações e próximas entregas

- **T01:** validador runtime escrito à mão e JSON Schema ainda precisam de teste cruzado de paridade.
- **T02:** ativação multi-arquivo com rollback best-effort, sem transação crash-safe/lock cross-process.
- **T03:** completions estáticas básicas; JSON Schema provider completo de VS Code/Monaco e ligação de credential vault/resolveOAuth assíncrono à execução pertencem à integração posterior.
- **T04/T09:** DNS pinning contra rebinding, política de redirects avançada, binário/stream e artefatos grandes, OAuth/session, redirecionamento de método seguro e APIs de transporte multiplataforma incompletos. Não utilizar esta versão como ferramenta de produção em redes não confiáveis.
- **T05:** foreach sequencial; sem executor paralelo, persisted progress ou recovery.
- **F01/F02:** CLI parcial, sem publicação npm nem `run-dir`. Preview/Apply de importação implementados; OAuth Discovery e salvamento de config presentes, mas `oauth connect` com navegador ainda não implementado.
- **T06:** login no navegador/loopback, refresh token e vault de plataforma ainda não conectados; discovery de rede tem DNS pré-check, mas não DNS pinning. Não usar autenticação externa em ambiente não confiável.
- **T07:** OpenAPI YAML não disponível sem parser robusto; imports só interpretam comandos cURL literais, sem executar scripts.
- **T08:** distribuição npm/CDN, runtime-browser, bundles por cliente e matriz de plataformas ainda não criados.
- **T11/T10:** faltam instalações reais de ESLint e Prettier, lockfile `npm ci`, gates CI de release.
- **F02-F10:** F02 parcial; servidores MCP, VS Code, Tauri e interfaces visuais de OAuth/Import continuam pendentes.

Referências: [PLAN e catálogo](https://docs.google.com/document/d/1D2mh30rbWwcS0c-XTFmYsfjQO7cyRxDsnTcTEkFdWMQ/edit), [ADR-001](https://docs.google.com/document/d/1ZOyoBgnItyS_QQGgtaClwJwiPq7czJAmYSEnwpofGDc/edit), [AGENTS](https://docs.google.com/document/d/1EbeQcW6rNCbxq4_UgCiP6E-4UC9607Bz9Q2VfgO-EJA/edit).
