#!/usr/bin/env node
import {startMcpFromCli} from './server.js';
void startMcpFromCli(process.argv.slice(2)).catch(error=>{
  const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'MCP_BOOT_FAILED';
  process.stderr.write(`json-http-mcp: ${code}\n`);
  process.exitCode=1;
});
