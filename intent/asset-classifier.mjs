// asset-classifier.mjs - Agent Foundry Deterministic Target Asset Classifier (PHASE 10.1)
//
// Invariants:
//   1. Canonical path resolution via realpathSync (AC-H1).
//   2. Anti-Symlink Traversal / Path Alias protection.
//   3. Deterministic code inspection of real physical target assets.
//   4. Canonical asset types: GOVERNANCE, SYSTEM_CONFIG, VAULT, KNOWLEDGE, DOCUMENT, CODE, TEMP_CACHE.
//   5. Canonical scopes: SYSTEM, PROJECT, LOCAL.

import { existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';

export const TARGET_ASSET_TYPES = Object.freeze({
  GOVERNANCE: 'GOVERNANCE',
  SYSTEM_CONFIG: 'SYSTEM_CONFIG',
  VAULT: 'VAULT',
  KNOWLEDGE: 'KNOWLEDGE',
  DOCUMENT: 'DOCUMENT',
  CODE: 'CODE',
  TEMP_CACHE: 'TEMP_CACHE',
});

export const IMPACT_SCOPES = Object.freeze({
  LOCAL: 'LOCAL',
  PROJECT: 'PROJECT',
  SYSTEM: 'SYSTEM',
});

/**
 * Resolve input path to its canonical physical target, defending against symlink traversal.
 *
 * Rules:
 * 1. If path exists: use realpathSync(path).
 * 2. If path does not exist: find closest existing parent directory, resolve its realpathSync,
 *    and join relative child path segments.
 *
 * @param {string|null} inputPath - Raw target path
 * @returns {{ raw_path: string, canonical_path: string, is_symlink: boolean, exists: boolean }}
 */
export function resolveCanonicalTarget(inputPath = '') {
  if (!inputPath || typeof inputPath !== 'string') {
    return {
      raw_path: '',
      canonical_path: '',
      is_symlink: false,
      exists: false,
    };
  }

  const raw = inputPath.trim();
  if (!raw) {
    return {
      raw_path: '',
      canonical_path: '',
      is_symlink: false,
      exists: false,
    };
  }

  const absolutePath = resolve(raw);

  // 1. File or directory physically exists: resolve realpath
  if (existsSync(absolutePath)) {
    try {
      const real = realpathSync(absolutePath);
      return {
        raw_path: raw,
        canonical_path: real,
        is_symlink: real !== absolutePath,
        exists: true,
      };
    } catch {
      // Fallback to absolute if read fails
    }
  }

  // 2. File does not exist yet: find closest existing parent directory
  let currentDir = dirname(absolutePath);
  const uncreatedParts = [basename(absolutePath)];

  while (currentDir && currentDir !== '/' && currentDir !== '.' && !existsSync(currentDir)) {
    uncreatedParts.unshift(basename(currentDir));
    const nextDir = dirname(currentDir);
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }

  let canonicalParent = currentDir;
  let isSymlinkParent = false;
  if (existsSync(currentDir)) {
    try {
      canonicalParent = realpathSync(currentDir);
      if (canonicalParent !== currentDir) {
        isSymlinkParent = true;
      }
    } catch {
      // Fallback
    }
  }

  const resolvedCanonical = join(canonicalParent, ...uncreatedParts);
  return {
    raw_path: raw,
    canonical_path: resolvedCanonical,
    is_symlink: isSymlinkParent,
    exists: false,
  };
}

/**
 * Deterministically classify a target asset based on real canonical path, capsule, and context.
 *
 * @param {string|null} targetPath - Path of the target file or directory
 * @param {object} [capsule] - Task Capsule context
 * @returns {{ type: string, path: string, canonical_path: string, is_symlink: boolean, scope: string, evidence: Array<{ rule: string, evidence: string, source: string }> }}
 */
export function classifyTargetAsset(targetPath = '', capsule = {}) {
  const rawTarget = String(targetPath || capsule?.target_path || capsule?.candidate?.target || '').trim();
  const resolved = resolveCanonicalTarget(rawTarget);
  const canonicalPath = resolved.canonical_path || '';
  const lowerCanonical = canonicalPath.toLowerCase();

  const goal = String(capsule?.goal || '').toLowerCase();
  const context = String(capsule?.context || '').toLowerCase();
  const evidence = [];

  if (resolved.is_symlink) {
    evidence.push({
      rule: 'CANONICAL_REALPATH_RESOLVED',
      evidence: `Resolved symlink '${resolved.raw_path}' -> '${canonicalPath}'`,
      source: 'asset-classifier',
    });
  }

  // 1. If canonical physical path is available, classify based on real physical path
  if (lowerCanonical) {
    if (
      /schema\.md/i.test(lowerCanonical) ||
      /schema\//i.test(lowerCanonical) ||
      /(^|\/|\\)index\.md$/i.test(lowerCanonical) ||
      /metadata/i.test(lowerCanonical) ||
      (capsule?.task_mode === 'governed_write' && (lowerCanonical.includes('schema') || lowerCanonical.includes('index')))
    ) {
      evidence.push({
        rule: 'REALPATH_GOVERNANCE_MATCH',
        evidence: `Canonical path points to governance asset (${canonicalPath})`,
        source: 'asset-classifier',
      });
      return {
        type: TARGET_ASSET_TYPES.GOVERNANCE,
        path: resolved.raw_path || canonicalPath,
        canonical_path: canonicalPath,
        is_symlink: resolved.is_symlink,
        scope: IMPACT_SCOPES.SYSTEM,
        evidence,
      };
    }

    if (
      /agents\.md/i.test(lowerCanonical) ||
      /scheduler\.json/i.test(lowerCanonical) ||
      /executors?\//i.test(lowerCanonical) ||
      /antigravity\.json|claude\.json|codex\.json/i.test(lowerCanonical) ||
      /runtime-guard/i.test(lowerCanonical) ||
      /mcp.*config/i.test(lowerCanonical)
    ) {
      evidence.push({
        rule: 'REALPATH_SYSTEM_CONFIG_MATCH',
        evidence: `Canonical path points to system configuration asset (${canonicalPath})`,
        source: 'asset-classifier',
      });
      return {
        type: TARGET_ASSET_TYPES.SYSTEM_CONFIG,
        path: resolved.raw_path || canonicalPath,
        canonical_path: canonicalPath,
        is_symlink: resolved.is_symlink,
        scope: IMPACT_SCOPES.SYSTEM,
        evidence,
      };
    }

    if (/(^|\/|\\)(tmp|temp|cache|build|\.cache)($|\/|\\)/i.test(lowerCanonical)) {
      return {
        type: TARGET_ASSET_TYPES.TEMP_CACHE,
        path: resolved.raw_path || canonicalPath,
        canonical_path: canonicalPath,
        is_symlink: resolved.is_symlink,
        scope: IMPACT_SCOPES.LOCAL,
        evidence,
      };
    }

    if (/agent-foundry-vault/i.test(lowerCanonical) || /vault\//i.test(lowerCanonical)) {
      evidence.push({
        rule: 'REALPATH_VAULT_MATCH',
        evidence: `Canonical path points to vault asset (${canonicalPath})`,
        source: 'asset-classifier',
      });
      return {
        type: TARGET_ASSET_TYPES.VAULT,
        path: resolved.raw_path || canonicalPath,
        canonical_path: canonicalPath,
        is_symlink: resolved.is_symlink,
        scope: IMPACT_SCOPES.PROJECT,
        evidence,
      };
    }

    const codeExtRegex = /\.(mjs|js|cjs|ts|py|go|java|rs|cpp|c|h|cs|rb|php|sh)$/i;
    if (codeExtRegex.test(lowerCanonical)) {
      return {
        type: TARGET_ASSET_TYPES.CODE,
        path: resolved.raw_path || canonicalPath,
        canonical_path: canonicalPath,
        is_symlink: resolved.is_symlink,
        scope: IMPACT_SCOPES.PROJECT,
        evidence,
      };
    }

    if (/\.(md|txt|rst|doc|docx)$/i.test(lowerCanonical)) {
      return {
        type: TARGET_ASSET_TYPES.DOCUMENT,
        path: resolved.raw_path || canonicalPath,
        canonical_path: canonicalPath,
        is_symlink: resolved.is_symlink,
        scope: IMPACT_SCOPES.PROJECT,
        evidence,
      };
    }
  }

  // 2. Fallback when path is empty: inspect goal & context
  const combined = `${goal}\n${context}`;
  if (
    combined.includes('修改schema') ||
    combined.includes('修改index规则') ||
    combined.includes('修改metadata规则') ||
    combined.includes('修改知识库目录结构') ||
    combined.includes('schema.md') ||
    (capsule?.task_mode === 'governed_write' && combined.includes('schema'))
  ) {
    evidence.push({
      rule: 'CONTEXT_GOVERNANCE_MATCH',
      evidence: 'Context explicitly targets governance rules or schema restructuring',
      source: 'asset-classifier',
    });
    return {
      type: TARGET_ASSET_TYPES.GOVERNANCE,
      path: 'SCHEMA.md',
      canonical_path: 'SCHEMA.md',
      is_symlink: false,
      scope: IMPACT_SCOPES.SYSTEM,
      evidence,
    };
  }

  if (
    combined.includes('修改agents.md') ||
    combined.includes('修改mcp配置') ||
    combined.includes('修改executor配置') ||
    combined.includes('修改scheduler配置') ||
    combined.includes('系统配置修改') ||
    combined.includes('agents.md')
  ) {
    evidence.push({
      rule: 'CONTEXT_SYSTEM_CONFIG_MATCH',
      evidence: 'Context explicitly targets system configuration or AGENTS.md',
      source: 'asset-classifier',
    });
    return {
      type: TARGET_ASSET_TYPES.SYSTEM_CONFIG,
      path: 'AGENTS.md',
      canonical_path: 'AGENTS.md',
      is_symlink: false,
      scope: IMPACT_SCOPES.SYSTEM,
      evidence,
    };
  }

  if (
    combined.includes('清理临时文件') ||
    combined.includes('清理缓存') ||
    combined.includes('clean tmp') ||
    combined.includes('clean cache') ||
    combined.includes('clean temp')
  ) {
    return {
      type: TARGET_ASSET_TYPES.TEMP_CACHE,
      path: '/tmp',
      canonical_path: '/tmp',
      is_symlink: false,
      scope: IMPACT_SCOPES.LOCAL,
      evidence,
    };
  }

  if (combined.includes('知识库') || capsule?.task_mode === 'governed_write') {
    return {
      type: TARGET_ASSET_TYPES.VAULT,
      path: 'agent-foundry-vault',
      canonical_path: 'agent-foundry-vault',
      is_symlink: false,
      scope: IMPACT_SCOPES.PROJECT,
      evidence,
    };
  }

  if (
    combined.includes('代码') ||
    combined.includes('接口') ||
    combined.includes('bug') ||
    combined.includes('修复')
  ) {
    return {
      type: TARGET_ASSET_TYPES.CODE,
      path: 'src/index.js',
      canonical_path: 'src/index.js',
      is_symlink: false,
      scope: IMPACT_SCOPES.PROJECT,
      evidence,
    };
  }

  return {
    type: TARGET_ASSET_TYPES.DOCUMENT,
    path: rawTarget || 'docs/README.md',
    canonical_path: canonicalPath || 'docs/README.md',
    is_symlink: resolved.is_symlink,
    scope: IMPACT_SCOPES.PROJECT,
    evidence,
  };
}
