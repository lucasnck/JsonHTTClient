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
