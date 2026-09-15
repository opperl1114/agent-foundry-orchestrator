// tests/helpers/acceptance-allowlist.mjs
//
// The shipped allowlist is deliberately narrow (node --test / npm test). The
// orchestration tests drive the acceptance stage with synthetic commands such
// as `node -e "process.exit(0)"`, which is exactly what the allowlist exists to
// forbid in production. Those tests opt into an explicit, wider allowlist here
// rather than the shipped control being weakened for everyone.
//
// AF_ACCEPTANCE_ALLOWLIST is read per call, so import order does not matter.
// An explicitly configured allowlist always wins.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ALLOWLIST_DIR = mkdtempSync(join(tmpdir(), 'af-acceptance-allowlist-'));
export const TEST_ACCEPTANCE_ALLOWLIST = join(ALLOWLIST_DIR, 'allowlist.json');

writeFileSync(TEST_ACCEPTANCE_ALLOWLIST, JSON.stringify({
  allowed: [
    { command: 'node', args_prefix: ['--test'] },
    { command: 'npm', args_prefix: ['test'] },
    { command: 'node', args_prefix: ['-e'] },
  ],
}, null, 2));

process.env.AF_ACCEPTANCE_ALLOWLIST ??= TEST_ACCEPTANCE_ALLOWLIST;
