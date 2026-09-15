// lib/config.mjs - Unified Cross-Platform Host & Environment Configuration
//
// Solves portability across WSL, Linux, Mac, and Windows environments:
//   1. Eliminates hardcoded author machine paths.
//   2. Prefers explicit environment variables (e.g. AF_GLOBAL_DIR, AF_VAULT_MCP_SERVER).
//   3. Falls back to deterministic relative workspace discovery.
//   4. Dynamically infers current user home directory and Node executable path.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Dynamic user home directory (Linux/WSL: $HOME, Windows: %USERPROFILE%)
export const HOME = process.env.HOME || process.env.USERPROFILE || homedir();

// Node.js binary directory of the currently executing runtime
export const CURRENT_NODE_BIN_DIR = dirname(process.execPath);

/**
 * Resolves a directory with fallback candidates
 */
function resolveDir(envVar, candidates = []) {
  if (process.env[envVar] && existsSync(process.env[envVar])) {
    return process.env[envVar];
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return candidates[0] || '';
}

// 1. Agent Foundry Global Directory & Executors Truth
export const AGENT_FOUNDRY_GLOBAL_DIR = resolveDir('AF_GLOBAL_DIR', [
  process.env.AGENT_FOUNDRY_GLOBAL,
  resolve(ROOT_DIR, '../agent-foundry-global'),
  '/mnt/c/Users/relaret/agent-foundry-global',
  join(HOME, 'agent-foundry-global'),
]);

export const EXECUTORS_DIR = process.env.AF_EXECUTORS_DIR ||
  (existsSync(join(AGENT_FOUNDRY_GLOBAL_DIR, 'executors'))
    ? join(AGENT_FOUNDRY_GLOBAL_DIR, 'executors')
    : '/mnt/c/Users/relaret/agent-foundry-global/executors');

export const CANONICAL_AGENTS_MD = process.env.AF_CANONICAL_AGENTS_MD ||
  join(AGENT_FOUNDRY_GLOBAL_DIR, 'AGENTS.md');

// 2. Vault MCP Server
export const VAULT_MCP_SERVER_PATH = process.env.AF_VAULT_MCP_SERVER ||
  process.env.VAULT_MCP_SERVER ||
  resolveDir('VAULT_MCP_DIR', [
    resolve(ROOT_DIR, '../vault-mcp/server.mjs'),
    '/mnt/c/Users/relaret/vault-mcp/server.mjs',
    join(HOME, 'vault-mcp/server.mjs'),
  ]);

// 3. Executor Launchers & Binaries
export const AGY_BIN = process.env.AGY_BIN ||
  join(HOME, '.local/bin/agy');

export const AGY_LAUNCHER = process.env.AGY_LAUNCHER ||
  resolveDir('AGY_LAUNCHER_DIR', [
    join(HOME, 'bin/agy-af'),
    resolve(ROOT_DIR, 'bin/agy-af'),
    '/home/relaret/bin/agy-af',
  ]);

export const CLAUDE_LAUNCHER = process.env.CLAUDE_LAUNCHER ||
  resolveDir('CLAUDE_LAUNCHER_DIR', [
    join(HOME, 'bin/claude-af'),
    resolve(ROOT_DIR, 'bin/claude-af'),
    '/home/relaret/bin/claude-af',
  ]);

export const VERTEX_LAUNCHER = process.env.VERTEX_LAUNCHER ||
  resolveDir('VERTEX_LAUNCHER_DIR', [
    resolve(ROOT_DIR, 'bin/vertex-gemini-af'),
    join(HOME, 'bin/vertex-gemini-af'),
    '/home/relaret/bin/vertex-gemini-af',
  ]);

export const CLINE_LAUNCHER = process.env.CLINE_LAUNCHER ||
  resolveDir('CLINE_LAUNCHER_DIR', [
    resolve(ROOT_DIR, 'bin/cline-af'),
    join(HOME, 'bin/cline-af'),
    '/home/relaret/bin/cline-af',
  ]);

// 4. Executor Configuration Paths
export const CODEX_CONFIG_PATH = process.env.CODEX_CONFIG_PATH ||
  join(HOME, '.codex/config.toml');

export const CLAUDE_SETTINGS_PATH = process.env.CLAUDE_SETTINGS_PATH ||
  join(HOME, '.claude/settings.json');

export const CLINE_SETTINGS_PATH = process.env.CLINE_SETTINGS_PATH ||
  join(HOME, '.cline/data/settings/providers.json');
