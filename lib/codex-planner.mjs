// lib/codex-planner.mjs - Codex LLM Plan Generator for Agent Foundry Planner Layer
//
// Invariants:
//   - Strict adherence to ROLE != PLATFORM: generated steps define canonical ROLES (author, worker, researcher, reviewer, verifier).
//   - Executes in read-only sandbox mode (no workspace side-effects).
//   - Strictly validates output JSON array against schema before returning.

import { spawn } from 'node:child_process';

const ALLOWED_ROLES = new Set(['author', 'reviewer', 'verifier', 'worker', 'researcher']);

export function normalizeRole(raw) {
  if (!raw || typeof raw !== 'string') return 'worker';
  const clean = raw.trim().toLowerCase();
  if (ALLOWED_ROLES.has(clean)) return clean;
  if (clean.includes('review') || clean.includes('审核') || clean.includes('审查') || clean.includes('质检')) return 'reviewer';
  if (clean.includes('verify') || clean.includes('测试') || clean.includes('验收')) return 'verifier';
  if (clean.includes('research') || clean.includes('架构') || clean.includes('调研') || clean.includes('设计') || clean.includes('规范')) return 'researcher';
  if (clean.includes('author') || clean.includes('作者') || clean.includes('核心')) return 'author';
  return 'worker';
}

export async function generatePlanWithCodex(capsule, {
  model = 'gpt-6-astra',
  effort = 'medium',
  timeoutMs = 300000,
} = {}) {
  const prompt = [
    'You are the Agent Foundry Task Planner.',
    'Analyze the user task goal and architecture context, and decompose it into an ordered list of clear, modular execution steps.',
    `TASK GOAL: ${capsule.goal}`,
    `CONTEXT: ${capsule.context || '(none)'}`,
    '',
    'Requirements:',
    '1. Decompose the goal into sequential, actionable steps.',
    '2. Each step must be a JSON object with:',
    '   - "step": integer starting from 1',
    '   - "goal": concise and clear sub-goal for this step',
    '   - "role": one of ["researcher", "worker", "author", "reviewer", "verifier"]. DO NOT use model or executor names.',
    '   - "description": specific instructions and deliverables for this step.',
    '3. Step sequence pattern:',
    '   - Step 1: Requirements analysis, protocol/API research, or specification (role: researcher)',
    '   - Subsequent steps: Discrete modular implementation of core components with automated tests (role: worker or author)',
    '   - Final step: Independent quality, safety, compliance review and acceptance verification (role: reviewer or verifier)',
    '4. Output ONLY a valid JSON array of step objects, no markdown fences, no other text.',
  ].join('\n');

  const args = ['exec', '--skip-git-repo-check', '-s', 'read-only', '-m', model];
  if (effort) {
    args.push('-c', `model_reasoning_effort="${effort}"`);
  }
  args.push('--json', '-');

  return new Promise((resolve, reject) => {
    const cp = spawn('codex', args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cp.kill('SIGTERM');
      reject(new Error(`Codex planner timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    cp.stdout.on('data', (d) => { stdout += d; });
    cp.stderr.on('data', (d) => { stderr += d; });
    cp.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Write prompt to stdin. A child that exits immediately (missing binary,
    // bad flag) closes the pipe under us: an unhandled EPIPE here would crash
    // the planner with an uncaught stream error instead of a clear failure.
    cp.stdin.on('error', () => { /* the close handler reports the real failure */ });
    try {
      cp.stdin.write(prompt);
      cp.stdin.end();
    } catch { /* ditto: EPIPE on a dead child is reported by 'close' */ }

    cp.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`Codex planner exited with code ${code}: ${stderr || stdout}`));
      }
      let messageText = '';
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const ev = JSON.parse(trimmed);
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
            messageText = ev.item.text || messageText;
          }
        } catch {}
      }
      if (!messageText) {
        return reject(new Error('No agent message returned from Codex planner'));
      }
      const cleaned = messageText.replace(/```json|```/g, '').trim();
      const s = cleaned.indexOf('[');
      const e = cleaned.lastIndexOf(']');
      if (s < 0 || e <= s) {
        return reject(new Error(`Codex planner did not return a JSON array: ${messageText.slice(0, 200)}`));
      }
      try {
        const parsed = JSON.parse(cleaned.slice(s, e + 1));
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return reject(new Error('Parsed plan is not a non-empty array'));
        }
        // Normalize roles and step indices
        const normalized = parsed.map((item, idx) => ({
          step: typeof item.step === 'number' ? item.step : idx + 1,
          goal: String(item.goal || `Step ${idx + 1}`).trim(),
          role: normalizeRole(item.role),
          description: String(item.description || item.goal || '').trim(),
        }));
        resolve(normalized);
      } catch (err) {
        reject(new Error(`Failed to parse Codex planner JSON: ${err.message}`));
      }
    });
  });
}
