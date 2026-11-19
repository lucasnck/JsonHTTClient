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
