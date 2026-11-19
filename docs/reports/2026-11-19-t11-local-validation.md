# T11 — Validação local do toolchain

Data: 2026-11-19. Ambiente Node 22.16.0, npm 10.9.2, TypeScript 5.8.3.

## Verificado

- `npm run check:offline`: **PASS** (executa `npm run typecheck` e `npm test`; NÃO executa ESLint/Prettier).
- TypeScript `tsc --noEmit -p tsconfig.json`: **PASS**, incluindo os flags estritos adicionados.
- TypeScript `tsc -p tsconfig.json`: **PASS**, gera `dist/` local.
- `node --test dist/test/*.test.js`: **22/22 PASS**, com 4 novos testes estáticos T11 para scripts, tsconfig, referências de ferramentas e sintaxe JS das configurações.
- `node --check eslint.config.mjs`, `node --check prettier.config.mjs`: **PASS** (valida apenas sintaxe, não executa plugins).

## Não verificado / bloqueios

- `npm install` falhou por `EAI_AGAIN registry.npmjs.org` na sandbox; ausência de DNS/registry.
- ESLint, `typescript-eslint`, Prettier e `eslint-config-prettier` ainda NÃO estão instalados para testes reais de lint e formatação.
- `npm run lint` e `npm run format:check`: **BLOCKED / NOT_RUN**, não reivindicar sucesso.
- Não foi criado `package-lock.json` (pendente geração via instalação bem-sucedida e commit); `npm ci` e integração CI completos **PENDING**.
- Os arquivos TS existentes ainda precisam passar por `npm run format` após instalar Prettier; é possível que format:check falhe inicialmente.

## Para concluir T11 em ambiente conectado

```sh
npm install
npm run format
npm run check
npm ci
npm run check
```

Após formatação, registrar arquivos alterados, versionar `package-lock.json`, anexar saída real dos checks e integrar CI T10. A spec T11 fica PENDING até esses gates.
