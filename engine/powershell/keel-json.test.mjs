// The container's JSON fallback (ops/powershell/keel-json.ps1, issue #638 and queue
// item Q179). ConvertTo-Json throws on unloaded PnP/CSOM collections and on Purview
// dictionaries whose keys are not strings; run-cmdlet.ps1 then writes a plain copy.
//
// The PowerShell checks run in real pwsh (ops/powershell/keel-json.tests.ps1). GitHub's
// ubuntu runners ship pwsh, so CI always runs them; a machine without pwsh skips only
// that one test and says why. Set KEEL_PWSH to use a pwsh that is not on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const opsDir = fileURLToPath(new URL('../../ops/powershell/', import.meta.url));
const read = (name) => readFileSync(`${opsDir}${name}`, 'utf8');

function findPwsh() {
  const candidate = process.env.KEEL_PWSH || 'pwsh';
  const probe = spawnSync(candidate, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
  return probe.status === 0 && Number(probe.stdout.trim()) >= 7 ? candidate : null;
}

test('run-cmdlet.ps1 writes every envelope through ConvertTo-KeelJson, and the image ships keel-json.ps1', () => {
  const script = read('run-cmdlet.ps1');
  assert.match(script, /^\. \(Join-Path \$PSScriptRoot 'keel-json\.ps1'\)$/m);
  const outEnvelope = /function Out-Envelope \{([\s\S]*?)\n\}/.exec(script)[1];
  assert.match(outEnvelope, /ConvertTo-KeelJson -Value \$Envelope -Depth 16/);
  const code = outEnvelope.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(code, /ConvertTo-Json /, 'Out-Envelope must not call ConvertTo-Json directly');
  assert.match(read('Dockerfile'), /^COPY keel-json\.ps1 \/app\/keel-json\.ps1$/m);
});

test('keel-json.ps1 survives unloaded CSOM collections and non-string keys, and leaves other answers unchanged (pwsh)', (t) => {
  const pwsh = findPwsh();
  if (!pwsh) {
    assert.ok(!process.env.GITHUB_ACTIONS, 'pwsh 7 must be on the CI runner');
    t.skip('pwsh 7 is not installed here; CI runs this test');
    return;
  }
  const run = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', `${opsDir}keel-json.tests.ps1`], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, `keel-json.tests.ps1 failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /^passed \d+$/m);
  // The two failures from the tenant are reproduced before they are fixed.
  assert.match(run.stdout, /^ok ConvertTo-Json still fails on an unloaded collection$/m);
  assert.match(run.stdout, /^ok ConvertTo-Json still fails on non-string keys$/m);
});
