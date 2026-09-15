// vault-client.mjs - minimal MCP stdio client for the Governance Bridge.
// Speaks just enough JSON-RPC to call tools on an already-working vault-mcp
// server. It implements ZERO governance logic: registration, candidates,
// review evidence, policy, human gate, writer lock and publish all remain
// owned by vault-mcp; this client only transports calls and returns verbatim
// results (governance_source = "vault-mcp").

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export class VaultMcpClient {
  constructor({ serverPath, vaultRoot, stateDb, env = {} }) {
    this.serverPath = serverPath;
    this.vaultRoot = vaultRoot;
    this.stateDb = stateDb;
    this.extraEnv = env;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(process.execPath, [this.serverPath], {
      env: {
        ...process.env,
        VAULT_ROOT: this.vaultRoot,
        ...(this.stateDb ? { VAULT_MCP_STATE_DB: this.stateDb } : {}),
        ...this.extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    createInterface({ input: this.proc.stdout, terminal: false }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg?.id != null && this.pending.has(msg.id)) {
        const { resolve, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
    this.proc.stderr.on('data', () => { /* server diagnostics; ignore */ });
  }

  // MCP handshake: initialize + initialized notification (required once)
  async ensureInitialized() {
    if (this.initialized) return;
    this.start();
    await new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('vault-mcp initialize timeout')); }, 30000);
      this.pending.set(id, { resolve, timer });
      this.proc.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'af-orchestrator-bridge', version: '1.0.0' } },
      })}\n`);
    });
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    this.initialized = true;
  }

  async call(name, args = {}, timeoutMs = 60000) {
    await this.ensureInitialized();
    const id = this.nextId++;
    const req = { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`vault-mcp call timeout: ${name}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.proc.stdin.write(`${JSON.stringify(req)}\n`);
    }).then((msg) => {
      if (msg.error) throw new Error(`vault-mcp ${name} protocol error: ${msg.error.message}`);
      const text = msg.result?.content?.[0]?.text ?? '';
      if (msg.result?.isError) {
        const err = new Error(`vault-mcp ${name} rejected: ${text}`);
        err.vault_rejected = true;
        err.vault_response = text;
        throw err;
      }
      // return parsed JSON when the tool answers with a single JSON object
      try { return { raw: text, json: JSON.parse(text) }; } catch { return { raw: text, json: null }; }
    });
  }

  stop() {
    if (this.proc) {
      // graceful stop: SIGTERM gives the server's sqlite connection a chance
      // to close and checkpoint WAL; SIGKILL would orphan the WAL and lose
      // un-checkpointed writes (the Phase 2 closure data-loss lesson).
      const p = this.proc;
      this.proc = null;
      try { p.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => {
        try { if (!p.killed || p.exitCode === null) p.kill('SIGKILL'); } catch { /* ignore */ }
      }, 500);
    }
  }
}
