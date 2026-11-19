# JSON HTTP Client — VS Code desktop (F04/F05 parcial)

A extensão usa o Extension Host Node do VS Code; não instala CLI nem roda daemon. Use o comando **Run HTTP Request** no editor nativo de `*.request.json` ou pelo menu de contexto do Explorer. Enquanto executa, use **Stop HTTP Request**. Cada Run abre um JSON **untitled** editável com `Save As` nativo. Fechar a aba descarta a visualização, sem recriar respostas fechadas nem disparar novo HTTP.

Os comandos **Activate Variables File** / **Deactivate Variables File** atuam em `variables.json` ou `*.variables.json` via motor compartilhado. Hover em `{{name}}` mostra valor/metadata e origem efetiva em prioridade alfabética de arquivos ativos. O Explorer recebe decoração por método e estado de variáveis. Os schemas de JSON contribuem para o editor nativo.

## Build e instalação local

```sh
npm run vscode:pack
# No VS Code desktop: Extensions > ... > Install from VSIX...
# Escolher artifacts/json-http-client-0.0.1.vsix
```

**Limites atuais:** sem testes reais no Extension Host (somente teste da integração sem VS Code); `vscode-shim.d.ts` é substituto temporário dos tipos oficiais @types/vscode indisponíveis no sandbox. A extensão exige workspace **local confiável** e HTTPS público por padrão. HTTP ou redes privadas permanecem bloqueados por padrão. O usuário pode ativar conscientemente as configurações globais de máquina `jsonHttp.allowHttp` e `jsonHttp.allowPrivateNetworks` para desenvolvimentos locais em workspace confiável; não ficam em settings do workspace. Credenciais OAuth ainda requerem adapter de host e não são solicitadas automaticamente. Suporte VS Code Web/Remote não foi validado. O VSIX tem empacotamento testável, mas a instalação real no VS Code continua PENDING até testes oficiais.
