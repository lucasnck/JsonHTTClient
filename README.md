# JsonHttpEngineWorkspace — TypeScript HTTP Engine

Implementação incremental do motor HTTP declarativo especificado em Google Drive. O código-fonte do motor é compartilhado entre os clientes e terá distribuição npm/CDN e bundles independentes, conforme a ADR-001. **Não há publicação npm, CDN, VSIX, MCP server ou Desktop instalável nesta entrega.**

## Implementado no código

- **T01 (parcial):** tipos TypeScript de RequestFile, Response individual e batch, validação inicial e JSON Schemas Draft 2020-12.
- **T02 (parcial):** arquivos `variables.json` e `*.variables.json`, `enabled`/`protected` por arquivo, herança física, precedência alfabética de múltiplos arquivos ativos, origem de cada variável e Activate/Deactivate.
- **T03 (parcial):** interpolação `{{name}}` em URL, headers, query, autenticação e body; tipos JSON preservados em placeholder completo; resolução recursiva, limites, detecção de ciclo/colisão/chaves inseguras, overrides de foreach; hover/completion/diagnósticos básicos e metadata OAuth sem login.
- **T04 (parcial):** cliente HTTP Node fetch, JSON/text/urlencoded/multipart textual, HTTP 4xx/5xx como Response real, headers de request/response normalizados, mascaramento de headers conhecidos, sessão temporária para revelar originais sem rerun, redirects revalidados e limites de timeout/tamanho.
- **T05 (parcial):** loop sequencial inline ou dataset JSON autorizado, `onError`, AbortSignal/Stop, eventos de progresso, batch `{summary,timings,results[]}`, preflight de variáveis e autorização protected antes do primeiro HTTP.
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

## Qualidade

```bash
npm run format       # Prettier --write (ainda não validado neste ambiente)
npm run check        # Prettier check + ESLint + TypeScript + testes
npm run check:offline # apenas TypeScript + testes, NÃO substitui npm run check
```

No ambiente de desenvolvimento desta entrega, `npm run check:offline` validou TypeScript e **65/65 testes** (contratos, variables, templates, HTTP real local, loop, política, CLI e boundary browser). ESLint/Prettier reais e CI continuam **NOT_RUN/BLOCKED** por falta de dependências acessíveis no registry. Não há lockfile. Nenhuma spec foi marcada `DONE` apenas por esses resultados.

## Limitações e próximas entregas

- **T01:** validador runtime escrito à mão e JSON Schema ainda precisam de teste cruzado de paridade.
- **T02:** ativação multi-arquivo com rollback best-effort, sem transação crash-safe/lock cross-process.
- **T03:** completions estáticas básicas; JSON Schema provider completo de VS Code/Monaco e OAuth token resolver assíncrono pertencem à integração posterior.
- **T04/T09:** DNS pinning contra rebinding, política de redirects avançada, binário/stream e artefatos grandes, OAuth/session, redirecionamento de método seguro e APIs de transporte multiplataforma incompletos. Não utilizar esta versão como ferramenta de produção em redes não confiáveis.
- **T05:** foreach sequencial; sem executor paralelo, persisted progress ou recovery.
- **F01:** CLI MVP, sem publicação npm e sem `run-dir`, sem autenticação OAuth e importadores.
- **T08:** distribuição npm/CDN, runtime-browser, bundles por cliente e matriz de plataformas ainda não criados.
- **T11/T10:** faltam instalações reais de ESLint e Prettier, lockfile `npm ci`, gates CI de release.
- **F02-F10:** servidores/hosts adicionais, VS Code/Tauri e fluxos OAuth/import não implementados.

Referências: [PLAN e catálogo](https://docs.google.com/document/d/1D2mh30rbWwcS0c-XTFmYsfjQO7cyRxDsnTcTEkFdWMQ/edit), [ADR-001](https://docs.google.com/document/d/1ZOyoBgnItyS_QQGgtaClwJwiPq7czJAmYSEnwpofGDc/edit), [AGENTS](https://docs.google.com/document/d/1EbeQcW6rNCbxq4_UgCiP6E-4UC9607Bz9Q2VfgO-EJA/edit).
