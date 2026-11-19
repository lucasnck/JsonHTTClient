# M0 — Relatório de implementação inicial

Data: 2026-11-19
Status: implementação iniciada localmente; **T01/T02 permanecem PENDING no roadmap** até cumprir todos os critérios, integrar ao repositório definitivo e demonstrar regressão/CI.

## Código produzido
- `contracts/request-file.schema.json`, `contracts/variables-file.schema.json`, `contracts/execution-result.schema.json` — contratos JSON Schema Draft 2020-12.
- `packages/core/src/contracts/types.ts`, `validation.ts` — tipos públicos e validação inicial de RequestFile e Result.
- `packages/core/src/variables/variables.ts` — normalização de nomes, prioridade alfabética, herança e origem efetiva de variáveis, e planejamento de toggle.
- `packages/runtime-node/src/variable-files.ts` — leitura de diretórios físicos e arquivos de variáveis, restrições básicas de raiz/symlink, ativação com escrita atômica por arquivo e rollback best-effort.
- `packages/sdk-js/src/index.ts` — exports públicos iniciais.
- `test/contracts.test.ts`, `test/variables.test.ts` — cenários unitários e integração filesystem.

## Validação executada
Ambiente: Node.js v22.16.0, npm 10.9.2, TypeScript 5.8.3.
Comando `npm run check`: TypeScript typecheck PASS, build PASS e Node test runner **18/18 testes PASS**. Os testes usam somente arquivos temporários e não enviam HTTP nem executam OAuth.
Commit Git local: `cf60fb6` (`feat(m0): bootstrap T01 contracts and T02 variable resolver`). Nenhum push ou PR remoto foi realizado porque nenhum repositório JsonHttpEngine estava acessível pela conexão GitHub.

## Não implementado / pendências
- T01 schema/validator parity usando validador Draft 2020-12; cobrir variants desconhecidas e JSON Schema de Result com fixture real de validator.
- T02 cross-process locks e recuperação atomic multi-file após crash; melhorar verificações TOCTOU e platform filesystem.
- T03 interpolação/Language Service; T04 transporte HTTP; T05 loop executor; T06 OAuth; T07 importadores; T08 runtime distribution ADR; T09 protected approval/SSRF; T10 CI.
- F01-F10: nenhuma FEATURE do cliente final foi implementada; nada instalável como VSIX/CLI/MCP/Desktop.
- A decisão de distribuição T08 ainda depende de aprovação do usuário. O bootstrap TS não implica decisão por Node sidecar, daemon ou CLI binário.

## Próximas ações
1. Alocar repositório GitHub do JsonHttpEngineWorkspace para persistir e versionar o código.
2. Encerrar T01 e T02 com os testes complementares e schemas validados por biblioteca padrão.
3. Desenvolver T03 (template resolver) e iniciar transporte HTTP T04 somente após estruturar T09/T08 necessárias.

## Atualização — T11: padronização do projeto (2026-11-19)
- Implementação local: `.editorconfig`, `eslint.config.mjs` (flat config ESLint 9 com typescript-eslint type-aware), `prettier.config.mjs`, `.prettierignore`, `tsconfig.base.json` e `tsconfig.json` compartilhando strict flags, `.vscode/settings.json` / `extensions.json`, novos scripts npm e testes de configuração.
- Node/TypeScript Typecheck e testes executados usando compilador e typings locais; evidências de comando devem acompanhar a entrega. Não se deve equiparar o script reduzido `check:offline` ao gate completo `npm run check`.
- Bloqueio: sandbox não alcança o registro npm (EAI_AGAIN), não foi possível instalar ESLint, typescript-eslint, Prettier nem gerar lockfile npm; `lint`/`format:check` reais permanecem NOT_RUN. T11 status PENDING até instalação, formatação, lint e CI reproduzível.
- ADR T08 aprovada posteriormente: Engine embutido nos clientes, npm e CDN ESM browser-safe; documento local de arquitetura corrigido.

## Avanço de implementação — T03, T04, T05, T09, F01 e T08 browser boundary (2026-11-19)

Código incremental na árvore `JsonHttpEngineWorkspace-with-history`:
- `packages/core/src/templates/interpolation.ts`, `packages/language-service/src/language-service.ts`: interpolação de strings/JSON, referências e limits; hover e completion compartilhados (T03 parcial).
- `packages/core/src/security/policies.ts`, `packages/runtime-node/src/http/fetch-transport.ts`: preflight de destino/protected, Node fetch com máscaras e response canonical (T04/T09 parciais).
- `packages/runtime-node/src/execution/loop-data.ts`, `packages/sdk-js/src/loop-execution.ts`: loop sequencial, file dataset, stop, progresso, preflight/approval (T05 parcial).
- `packages/sdk-js/src/execution.ts`, `apps/cli/src/main.ts`: SDK execute e CLI inicial Run/List/Explain (F01 parcial).
- `packages/sdk-js/src/index.browser.ts`: entrada para módulos puramente JavaScript/browser-safe sem importar Node (T08 parcial; CDN/runtime browser não implementados).
- `test/{templates,http,loop,cli,browser-boundary}.test.ts`: 44 novos testes após a T11, total 65.

Validação AUTOMATIZADA realizada: Node.js v22.16.0, npm 10.9.2, TypeScript 5.8.3; `npm run check:offline` = typecheck/build PASS, 66/66 Node tests PASS, 0 FAIL. HTTP local (`node:http`) exercitou 200, 400, 500, masking, timeout, cancelamento, redirection e CLI. Isso NÃO é aprovação funcional do usuário nem gate completo T11/T10. ESLint/Prettier/lockfile/CI ainda NOT_RUN/BLOCKED.

Riscos e pendências: DNS pinning/SSRF robusto não concluído; arquivos binários/stream e response binary ainda unsupported explicitamente; HTTP client ainda não suporta OAuth login; browser build por CDN ainda não existe; CLI não tem run-dir; TypeScript configs precisam rodar format/lint; manter todas TECH/FEATURE afetadas PENDING até cobertura integral. Sem push GitHub (repositório não foi localizado na conexão atual). A avaliação funcional do usuário foi explicitamente adiada para o final do desenvolvimento; continuar de forma incremental sem exigir aprovações intermediárias.

## Incremento — T06/T07/F02 (2026-11-19)

- **T06 parcial:** packages/core/src/oauth/{discovery,pkce}.ts e packages/runtime-node/src/oauth/{discovery,variable-writer,token-exchange}.ts. Discovery OIDC/RFC8414 com validação de issuer/endpoints, HTTPS e DNS public precheck; sem seguir redirects, com timeout e limite de bytes. Salva objetos OAuth em arquivo selecionado sem tokens; novo arquivo nasce desativado quando já existe outro ativo. PKCE S256/state; troca de authorization code em token endpoint HTTPS com vault INJETADO (nada persiste em variables.json). Falta navegador/callback/refresh e armazenamento seguro real dos hosts; DNS pinning T09 continua pendente.
- **T07 parcial:** packages/importers/src/{import-plan,curl,openapi}.ts + runtime-node/src/importers/apply.ts. Preview cURL/Bash literal, OpenAPI 3.x JSON, geração de filename portável, sanitização de headers de autenticação em placeholders, Apply explícito com authorized root, no-overwrite, rollback best-effort. YAML/OpenAPI $ref avançados e parser shell complexo não suportados; nunca executar Bash.
- **F02 parcial:** comandos CLI oauth discover, oauth save, import curl|bash|openapi com preview/apply, variables activate/deactivate; usam os módulos SDK. `oauth connect` ainda não implementado.
- **T08 browser boundary:** novos módulos core/importers/PKCE foram exportados no SDK browser-safe sem importar Node; artefato CDN ainda não gerado.
- Validação executada: `npm run check:offline`, typecheck/build PASS, Node test runner **95/95 PASS, 0 FAIL**. Inclui testes OAuth Discovery/PKCE/token vault mock, importers estáticos, CLI subprocess. `npm run check` (ESLint/Prettier) permanece NOT_RUN/BLOCKED porque dependências npm de lint/format não estão instaladas neste ambiente; npm registry inacessível e CI T10 não configurado.
- Não marcar T06/T07/F02 ou nenhuma outra spec DONE sem aceite integral. Usuário explicitou que realizará validação funcional ao final; o Implementer deve continuar testes automatizados e relatar evidências, sem exigir aprovação intermediária.

## Incremento F03 / T06: servidor MCP stdio + OAuth na execução (2026-11-19)

- Código TypeScript: `apps/mcp-server/src/{server,main}.ts` implementa o servidor MCP inicial por JSON-RPC 2.0 em stdio (initialize/ping/tools/list/tools/call). Consulta de requests e variáveis, validação, execução HTTP/loop, Stop, ativação/desativação, preview de import e operações OAuth de configuração. `--root` define limite físico, `--allow-run`/`--allow-write`/`--allow-oauth-discovery` controlam capacidades do servidor por configuração de host; `--allow-protected` libera proteção somente mediante autorização explícita de início do processo. Nenhuma ferramenta pode conceder permissões com seus próprios argumentos. Valores de variáveis não são devolvidos pelo MCP explain; headers sensíveis na saída padrão permanecem mascarados.
- `packages/sdk-js/src/oauth-request.ts` acrescenta interpolação OAuth assíncrona em duas etapas: política HTTP e preflight de arquivos `protected` antes de consultar credencial; token só no request efetivo, e não pode alterar URL de destino já autorizada. `executeRequestFile` e `executeLoop` compartilham o método.
- `packages/runtime-node/src/oauth/{connect,session-resolver}.ts`: `connectOAuthSession` orquestra PKCE/browser-host/callback/token exchange/injeção de vault e `createOAuthVaultTokenProvider` consulta token do host, respeita expiração e chave estável por arquivo/nome/issuer/clientId/scopes. Nenhum token ou refresh é escrito em variables.json. Login visual, armazenamento seguro real, refresh e callback Tauri/VSCode/CLI ainda PENDING.
- `apps/cli/src/main.ts` ganha `mcp serve` como outra entrada do mesmo servidor; scripts npm incluem `mcp`, bin `json-http-mcp`, sem publicar pacote real.
- Testes novos `test/oauth-runtime.test.ts` e `test/mcp.test.ts` cobrem protocolo stdio, read-only default, mutações autorizadas, precedência D35, mascaramento/escopo de credenciais, preflight protected, HTTP/Stop, import read-only e mock OAuth PKCE host/vault. Execução Node v22/TypeScript 5.8.3: `npm run check:offline` -> typecheck PASS, build PASS, **110/110 tests PASS**. O gate completo `npm run check` permanece NOT_RUN porque ESLint/Prettier não foram instalados neste sandbox; package-lock/CI e npm/CDN publicação ainda pendentes.
- Riscos: MCP testado com protocolo local, ainda SEM teste via SDK/Inspector oficial ou clientes externos. DNS pinning e proteção SSRF de runtime Node/OAuth continuam parciais; não expor em redes não confiáveis ou declarar pronto para produção. MCP `request_run_dir`/`import_apply`/OAuth connect no host e VS Code/Desktop continuam PENDING. Não marcar T06/T09/F03/T10 como DONE sem esses critérios. Validação funcional do usuário reservada para o fim.

Documentação adicional: `docs/MCP-SETUP.md` e `docs/OAUTH-HOST.md`.

## Incremento — F04/F05 extensão VS Code, Git remoto configurado (2026-11-19)

- O remoto local **origin** aponta para `https://github.com/lucasnck/JsonHTTClient.git`, branch **main**; NÃO executar push conforme solicitação do usuário. O repositório remoto está vazio; referências de rastreamento locais antigas foram removidas, sem alterar remoto. Usuário publicará quando quiser (`git push -u origin main`).
- `apps/vscode/src/runner.ts`: Run de buffer JSON ainda não salvo, contrato T01, resolução D35, preflight de protected, HTTP/loop via SDK existente e resultado JSON canônico (sem duplicar motor).
- `apps/vscode/src/extension.ts`: comandos nativos Run/Stop, editor untitled JSON com Save As normal, progresso, cancelamento, modal de protected, hover/completion de variáveis, diagnostics, Explorer FileDecoration por HTTP method e enabled/protected, context menus de Activate/Deactivate usando T02. Configurações de máquina para HTTP privado/sem TLS apenas opt-in, workspace local confiável obrigatório.
- `apps/vscode/package.json`: VS Code contribution de comandos, editor/title, explorer/context e mapeamento de JSON schemas para os dois formatos de arquivo. O build inclui as declarações de API simplificadas em `vscode-shim.d.ts` porque `@types/vscode` ainda não está instalado; MUST substituir pelos tipos oficiais antes de publicar.
- `tooling/package-vsix.mjs` é empacotador ZIP/VSIX sem bibliotecas npm externas; `npm run vscode:pack` gera `artifacts/json-http-client-0.0.1.vsix` com Core/SDK/runtime Node necessários, sem CLI global. Validado com zipfile.testzip() e assets do manifest presentes, **mas não instalado no VS Code real**.
- Testes `test/vscode-runner.test.ts`, `test/vscode-manifest.test.ts`: request de buffer não salvo, Request/Response JSON, masked Authorization, protected deny antes da rede, foreach cancelado, arquivos fora da raiz, menus/schemas. Total: **115/115 testes Node PASS**, typecheck/build PASS, pacote VSIX CRC PASS.
- `npm run check` completo BLOQUEADO em `prettier: not found` (dependências npm indisponíveis); não alegar lint/format/CI PASS.
- Status F04/F05/T08/T10/T11 = PENDING: não houve VS Code Extension Host smoke, OAuth host, validação oficial `@types/vscode`, VSIX install ou Marketplace; Desktop e npm/CDN também pendentes.

## Incremento F06 / F01 run-dir / F03 & F08 MCP (2026-11-19)

- F06 parcial: `DesktopTabSessions` usa `DesktopEngineBridge`, mantém somente abas abertas,
  ActiveTab, Run/Stop/Response JSON editável, Save As, restauração sem reexecutar HTTP,
  remove snapshots de abas fechadas. `NodeDesktopBridge` reusa
  `packages/runtime-node/src/editor-execution.ts` para execução SDK sem duplicação de HTTP.
  `NodeDesktopSessionStore` persiste no app-data escolhido, arquivo 0600, escrita atômica
  por arquivo, sem tokens OAuth. Unsaved user edits não persistem; response body HTTP
  permanece fiel ao contrato T01 (não é automaticamente mascarado). Tauri + React/Monaco
  e instalador NÃO criados; não marcar F06 DONE.
- F01 parcial: `executeRequestDirectory` percorre somente `*.request.json` físico
  em ordem estável, `--recursive`, root autorizada e symlink skip; agrupa resultados
  canônicos por arquivo, com resumo e Stop. CLI `run-dir` usa SDK, stdout apenas JSON
  e progresso stderr.
- F03/F08 parciais: MCP `request_run_dir` requer host --allow-run e
  `import_apply` requer DUAS flags de host --allow-write + --allow-import-apply;
  args de tools não autorizam a si próprias. Aplicação não sobrescreve arquivos
  e valida root; protocolo stdio agora espera requests pendentes no close.
- Regressão: `npm run check:offline` = TypeScript typecheck PASS, build PASS,
  **126/126 node:test PASS**; tests de session store, sem network restore, acesso
  filesystem, CLI run-dir e MCP permissions. npm run check full ainda BLOQUEADO
  por Prettier/ESLint indisponíveis; VS Code real, MCP SDK oficial, Tauri e
  segurança DNS de produção ainda NOT_RUN/PENDING.
- Git: branch local main, remote origin configurado, sem push. Os artefatos serão
  atualizados no Drive, com ZIP do repositório Git completo e fonte para publicação
  pelo usuário posteriormente. A revisão funcional permanece agendada para o final.


## Incremento T08 — Browser HTTP runtime e empacotamento ESM (2026-11-19)

- `packages/runtime-browser/src/browser-http.ts`: adaptador fetch browser-safe
  que preserva response 4xx/5xx, limita bytes/timeout, mascara somente headers,
  nega redirects automáticos e mantém protected preflight. CORS/network failures
  geram diagnostic out-of-band e response:null, sem inventar status HTTP.
- `packages/sdk-js/src/index.browser.ts` exporta executeBrowserRequest e
  capabilities explícitas de browser (sem filesystem/keychain/local OAuth).
- `tooling/package-browser.mjs`: empacota grafo ESM estático compilado,
  verificado contra Node-only imports, em artifacts/browser-esm, com index.mjs
  e package.json; NÃO publica URL ou pacote npm, nem promete single-file bundle.
- `test/browser-http.test.ts` e `test/browser-package.test.ts`: fetch mock,
  CORS simulada, response bodies, protected, transporte e import ESM local.
- `npm run check:offline`: typecheck/build **PASS, 130/130 testes PASS**, 0 fail.
- `npm run browser:pack`: build local PASS. Testes reais de navegador/CDN/npm
  publishing continuam PENDING; gate full ESLint/Prettier/CI ainda BLOQUEADO.
- F06 permanece parcial (não há Tauri/React/Monaco), F01/F03/F08 parciais,
  e todas as specs sem critério integral permanecem PENDING. Git origin/main
  configurados sem qualquer push, seguindo pedido do usuário.
