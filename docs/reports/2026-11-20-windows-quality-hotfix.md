# T10/T11 — Correções e validação local no Windows

Ambiente: Windows x64, Node v22.15.0, npm 10.9.2. Trabalho local, sem commit ou push.

## Escopo e referências

Correção do gate de qualidade e das falhas Windows após o overlay 94d57c1.
Foram seguidas [T11](https://docs.google.com/document/d/1xPzujZkIrudInOmfBVo9yHULvv56fFjpuHmCy9nLG4k/edit),
[T10](https://docs.google.com/document/d/1-E3fJLo5-REFdo6syQMm5uclODtFIaPtedgPuhVlndg/edit)
e as [instruções do hotfix](https://docs.google.com/document/d/1K32MsKOu8ATvhH0BZH7Tajmo6Q2Qfo8AXg5v5BukAoE/edit).
T10/T11 e as features de host/release continuam PENDING: este relatório comprova a validação local deste escopo.

## Alterações

- `eslint.config.mjs`: excluir artefatos gerados e targets Rust; declarar globais dos scripts Node. Manter recommendedTypeChecked e projectService. Permitir callbacks async imediatos apenas nos testes que simulam ports; as demais regras de promises e segurança de tipos continuam ativas.
- CLI/MCP, core e runtime: remover imports, tipos e assertions redundantes; explicitar Promises de approval, estreitar tipos de escalares e valores externos, tipar arrays OpenAPI e o motivo de cancelamento como unknown. A validação de onError aceita somente os valores do contrato.
- Testes: registrar node:test com void; substituir any por tipos e asserts nos protocolos, manifests e arquivos JSON; usar basename para caminhos de cada plataforma e tolerar a vírgula final produzida por Prettier no teste do VS Code.
- `tooling/desktop-workflow.mjs`: dry-runs consultam os manifests locais sem executar npm ls. Execuções reais continuam verificando a árvore de dependências.
- Testes desktop: dar ao doctor tempo compatível com seus probes limitados; ampliar apenas a espera de inicialização do sidecar, mantendo os limites de aprovação; aceitar runtime novo ou já preparado. Adicionada regressão com npm sentinela para detectar qualquer execução de npm em dry-runs.
- `apps/desktop/ui/src/vite-env.d.ts`: declarar os tipos Vite e dos workers Monaco usados pelo bundle local.

As alterações anteriores do overlay e dos ZIPs em versions foram preservadas.

## Evidências

| Comando                         | Resultado                                                |
| ------------------------------- | -------------------------------------------------------- |
| `npm run format`                | PASS, exit 0                                             |
| `npm run format:check`          | PASS no check completo                                   |
| `npm run lint`                  | PASS, zero warnings, no check completo                   |
| `npm run typecheck`             | PASS no check completo                                   |
| `npm test`                      | PASS: build e 156 testes; 155 PASS, 0 FAIL, 1 SKIP       |
| `npm run check`                 | PASS, exit 0                                             |
| `npm run desktop:ui:build`      | PASS: TypeScript da UI e Vite; aviso de tamanho de chunk |
| `npm run desktop:runtime:stage` | PASS: Node local win32/x64 verificado e preparado        |
| `npm run desktop:bundle:check`  | PASS: engine, UI e Node local presentes                  |

O único skip é o teste POSIX de child.kill(SIGINT), que não simula Ctrl+C no Windows.
Os testes de AbortSignal, Stop, aprovação nativa via protocolo, persistência, HTTP local, CLI e MCP continuam executados.

Probes negativos isolados também passaram: Prettier rejeitou JSON sem formatação
(exit 1), ESLint rejeitou variável não usada (exit 1), TypeScript rejeitou atribuição
de string a number com TS2322 (exit 2). Os arquivos temporários foram removidos.

## Limitações

Rust/Cargo continuam ausentes. O doctor retorna exit 1 por esses pré-requisitos;
Node/npm, SDK nativo e dependências JavaScript estão disponíveis.
Nenhuma instalação de ferramentas do sistema foi realizada.
O gate do bundle verifica entradas, não comprova build Rust ou instalador.
Tauri nativo, diálogo real, instalação e smoke do aplicativo permanecem NOT_RUN.
CI multiplataforma e npm ci em checkout limpo não foram executados neste ajuste.
Nenhuma spec foi marcada DONE.
