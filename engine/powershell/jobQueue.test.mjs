// Offline unit test for jobQueue.mjs — stubs the container invocation via the
// injectable `spawnFn`, so this runs with no Docker daemon and no network.
//
//   cd /opt/keel && node engine/powershell/jobQueue.test.mjs

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJob, JobQueueError, DEFAULT_MEMORY, CONTAINER_CREDENTIAL_DIR, defaultScriptMount } from './jobQueue.mjs';

/**
 * Builds a fake ChildProcess-shaped object. Emits its scripted stdout/stderr
 * and a close/error event on the next microtask, mirroring how a real
 * child_process.spawn result behaves (events land asynchronously).
 */
function makeFakeChild({ stdoutChunks = [], stderrChunks = [], exitCode = 0, emitError = null, neverClose = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const written = [];
  child.stdin = {
    write(chunk) { written.push(chunk); },
    end() {},
  };
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.__written = written;

  queueMicrotask(() => {
    if (emitError) {
      child.emit('error', emitError);
      return;
    }
    for (const c of stdoutChunks) child.stdout.emit('data', Buffer.from(c));
    for (const c of stderrChunks) child.stderr.emit('data', Buffer.from(c));
    if (!neverClose) child.emit('close', exitCode);
  });

  return child;
}

async function run() {
  // 1. Successful round-trip: verifies the docker invocation shape (memory
  //    cap, read-only credential mount, image) AND that stdout JSON comes
  //    back parsed.
  {
    let capturedBin;
    let capturedArgs;
    let capturedWritten;
    const spawnFn = (bin, args) => {
      capturedBin = bin;
      capturedArgs = args;
      const child = makeFakeChild({
        stdoutChunks: [JSON.stringify([
          { workload: 'exo', connected: true, cmdlet: 'Get-OrganizationConfig', ok: true, count: 1, error: null },
        ])],
      });
      capturedWritten = child.__written;
      return child;
    };

    const { jobId, result, stderr } = await runJob(
      { adapter: 'powershell/probe', mode: 'probe', workload: 'exo' },
      { spawnFn, image: 'keel-powershell:test' },
    );

    assert.equal(capturedBin, 'docker');
    assert.equal(stderr, '');
    assert.ok(capturedArgs.includes('run'));
    assert.ok(capturedArgs.includes('--rm'));
    assert.ok(capturedArgs.includes('-i'));

    const memIdx = capturedArgs.indexOf('--memory');
    assert.ok(memIdx >= 0, '--memory flag must be present');
    assert.equal(capturedArgs[memIdx + 1], DEFAULT_MEMORY);

    const swapIdx = capturedArgs.indexOf('--memory-swap');
    assert.ok(swapIdx >= 0, '--memory-swap must be present so no extra swap headroom is granted');
    assert.equal(capturedArgs[swapIdx + 1], DEFAULT_MEMORY);

    assert.ok(!capturedArgs.some((a) => String(a).startsWith('/etc/keel:')), '/etc/keel is never mounted whole');
    assert.ok(!capturedArgs.includes('host'), 'the container never shares the host network');
    const flag = (name) => capturedArgs[capturedArgs.indexOf(name) + 1];
    assert.equal(flag('--network'), 'bridge');
    assert.ok(capturedArgs.includes('--read-only'), 'the root filesystem is read-only');
    assert.equal(flag('--cap-drop'), 'ALL');
    assert.equal(flag('--security-opt'), 'no-new-privileges');
    assert.ok(Number(flag('--pids-limit')) > 0, 'the process count is capped');
    assert.match(flag('--user'), /^\d+:\d+$/);
    assert.notEqual(flag('--user').split(':')[0], '0', 'the container never runs as root');
    assert.match(flag('--tmpfs'), /^\/tmp:/);
    assert.ok(capturedArgs.includes('keel-powershell:test'));
    assert.equal(capturedArgs[capturedArgs.length - 1], 'keel-powershell:test', 'image must be the last arg');

    assert.ok(Array.isArray(result));
    assert.equal(result[0].workload, 'exo');
    assert.ok(typeof jobId === 'string' && jobId.length > 0);

    // The job written to the container's stdin must be valid JSON carrying
    // the fields we passed plus a generated jobId.
    const sentJob = JSON.parse(capturedWritten.join(''));
    assert.equal(sentJob.adapter, 'powershell/probe');
    assert.equal(sentJob.mode, 'probe');
    assert.equal(sentJob.workload, 'exo');
    assert.equal(sentJob.jobId, jobId);
  }

  // 2. A supplied jobId is passed through rather than overwritten.
  {
    const spawnFn = () => makeFakeChild({ stdoutChunks: ['[]'] });
    const { jobId } = await runJob({ mode: 'probe', jobId: 'fixed-id-123' }, { spawnFn });
    assert.equal(jobId, 'fixed-id-123');
  }

  // 3. Non-zero exit surfaces the container's real stderr in the error message.
  {
    const spawnFn = () => makeFakeChild({ stderrChunks: ['Connect-ExchangeOnline: boom'], exitCode: 1 });
    await assert.rejects(
      () => runJob({ mode: 'probe' }, { spawnFn }),
      (err) => {
        assert.ok(err instanceof JobQueueError);
        assert.equal(err.code, 'NONZERO_EXIT');
        assert.match(err.message, /boom/);
        assert.match(err.message, /exited 1/);
        return true;
      },
    );
  }

  // 4. Malformed stdout (not JSON) is a distinct, clearly-labelled failure mode.
  {
    const spawnFn = () => makeFakeChild({ stdoutChunks: ['not json'], exitCode: 0 });
    await assert.rejects(
      () => runJob({ mode: 'probe' }, { spawnFn }),
      (err) => {
        assert.ok(err instanceof JobQueueError);
        assert.equal(err.code, 'BAD_JSON');
        return true;
      },
    );
  }

  // 4b. Warning lines pwsh prints before the answer (ANSI-coloured) don't hide it: the
  //     last line is the answer and the warnings land in stderr. Noise after the answer,
  //     or no JSON line at all, is still BAD_JSON.
  {
    const warning = '\u001b[33;1mWARNING: Force Validate not set\u001b[0m\n';
    const answer = JSON.stringify({ ok: true, output: [{ Name: 'KEEL-RT-policy' }] });
    const spawnFn = () => makeFakeChild({ stdoutChunks: [warning, warning, `${answer}\n`], exitCode: 0 });
    const res = await runJob({ mode: 'probe' }, { spawnFn });
    assert.deepEqual(res.result, JSON.parse(answer));
    assert.match(res.stderr, /WARNING: Force Validate not set\nWARNING: Force Validate not set\n$/);
    assert.doesNotMatch(res.stderr, /\u001b/);

    for (const stdout of [`${answer}\nWARNING: after\n`, 'WARNING: one\nWARNING: two\n']) {
      const bad = () => makeFakeChild({ stdoutChunks: [stdout], exitCode: 0 });
      await assert.rejects(() => runJob({ mode: 'probe' }, { spawnFn: bad }), (err) => err instanceof JobQueueError && err.code === 'BAD_JSON');
    }
  }

  // 5. A spawn failure (e.g. docker not installed) surfaces as SPAWN_ERROR,
  //    not an unhandled rejection or a hang.
  {
    const spawnFn = () => makeFakeChild({ emitError: new Error('ENOENT: docker not found') });
    await assert.rejects(
      () => runJob({ mode: 'probe' }, { spawnFn }),
      (err) => {
        assert.ok(err instanceof JobQueueError);
        assert.equal(err.code, 'SPAWN_ERROR');
        assert.match(err.message, /ENOENT/);
        return true;
      },
    );
  }

  // 6. A hung container (never closes) is killed and rejected once the
  //    timeout budget is exhausted — this is the safety net for a runaway
  //    pwsh process on a memory-constrained host.
  {
    let killed = false;
    const spawnFn = () => {
      const child = makeFakeChild({ neverClose: true });
      const originalKill = child.kill;
      child.kill = (...a) => { killed = true; return originalKill(...a); };
      return child;
    };
    await assert.rejects(
      () => runJob({ mode: 'probe' }, { spawnFn, timeoutMs: 20 }),
      (err) => {
        assert.ok(err instanceof JobQueueError);
        assert.equal(err.code, 'TIMEOUT');
        return true;
      },
    );
    assert.ok(killed, 'the child must be killed on timeout');
  }

  // 7. job must be a plain object. runJob is async, so an invalid job
  //    surfaces as a rejected promise, not a synchronous throw.
  {
    await assert.rejects(() => runJob(null), TypeError);
    await assert.rejects(() => runJob('nope'), TypeError);
    await assert.rejects(() => runJob(['array']), TypeError);
  }

  // 8. The deployed ops/powershell is mounted read-only over /app, so the cmdlet
  //    allowlist a job sees is never a stale copy baked into the image (#339).
  {
    let args;
    const spawnFn = (bin, a) => { args = a; return makeFakeChild({ stdoutChunks: ['[]'] }); };
    await runJob({ mode: 'probe' }, { spawnFn });
    const mount = defaultScriptMount();
    assert.equal(mount, fileURLToPath(new URL('../../ops/powershell', import.meta.url)));
    assert.ok(args.includes(`${mount}:/app:ro`), 'the deployed scripts must be mounted read-only over /app');
    assert.ok(args.indexOf(`${mount}:/app:ro`) < args.length - 1, 'the mount comes before the image');

    await runJob({ mode: 'probe' }, { spawnFn, scriptMount: null });
    assert.ok(!args.some((a) => String(a).endsWith(':/app:ro')), 'scriptMount null keeps the image copy');

    let spawned = false;
    await assert.rejects(
      () => runJob({ mode: 'probe' }, { spawnFn: () => { spawned = true; return makeFakeChild(); }, scriptMount: '/nonexistent/keel-scripts' }),
      (err) => err instanceof JobQueueError && err.code === 'SCRIPTS_MISSING',
    );
    assert.equal(spawned, false, 'nothing runs when the scripts are missing');
  }

  // 9. Only the job's own settings, certificate and key reach the container (audit
  //    run 2, finding 8): copied into a private directory that is mounted read-only,
  //    with the settings pointing at the copies, and removed when the job ends.
  {
    const root = mkdtempSync(join(tmpdir(), 'keel-cred-root-'));
    const staging = mkdtempSync(join(tmpdir(), 'keel-cred-stage-'));
    try {
      writeFileSync(join(root, 'cert.pem'), 'CERT');
      writeFileSync(join(root, 'key.pem'), 'KEY');
      writeFileSync(join(root, 'other-secret.env'), 'NOT FOR THIS JOB');
      writeFileSync(join(root, 'tenant.json'), JSON.stringify({ clientId: 'c', certPath: join(root, 'cert.pem'), keyPath: join(root, 'key.pem') }));
      let args;
      let seen;
      let sent;
      const spawnFn = (bin, a) => {
        args = a;
        const mount = a[a.indexOf('-v') + 1];
        const [hostDir, containerDir, mode] = mount.split(':');
        assert.equal(containerDir, CONTAINER_CREDENTIAL_DIR);
        assert.equal(mode, 'ro');
        seen = Object.fromEntries(readdirSync(hostDir).sort().map((name) => [name, readFileSync(join(hostDir, name), 'utf8')]));
        seen.hostDir = hostDir;
        const child = makeFakeChild({ stdoutChunks: ['[]'] });
        sent = child.__written;
        return child;
      };
      await runJob({ mode: 'probe', tenantConfigPath: join(root, 'tenant.json') }, { spawnFn, credentialRoot: root, stagingRoot: staging });
      assert.deepEqual(Object.keys(seen).filter((k) => k !== 'hostDir').sort(), ['cert.pem', 'key.pem', 'tenant.json'], 'only the three files are staged');
      assert.equal(seen['cert.pem'], 'CERT');
      assert.equal(seen['key.pem'], 'KEY');
      assert.deepEqual(JSON.parse(seen['tenant.json']), { clientId: 'c', certPath: `${CONTAINER_CREDENTIAL_DIR}/cert.pem`, keyPath: `${CONTAINER_CREDENTIAL_DIR}/key.pem` });
      assert.equal(JSON.parse(sent.join('')).tenantConfigPath, `${CONTAINER_CREDENTIAL_DIR}/tenant.json`);
      assert.ok(!args.some((a) => String(a).startsWith(`${root}:`)), 'the credential root itself is not mounted');
      assert.equal(existsSync(seen.hostDir), false, 'the staged copy is removed after the job');

      // A failed job also removes the copy.
      await assert.rejects(() => runJob({ mode: 'probe', tenantConfigPath: join(root, 'tenant.json') }, {
        spawnFn: (bin, a) => { seen.hostDir = a[a.indexOf('-v') + 1].split(':')[0]; return makeFakeChild({ exitCode: 1 }); },
        credentialRoot: root, stagingRoot: staging,
      }), JobQueueError);
      assert.equal(existsSync(seen.hostDir), false, 'the staged copy is removed after a failed job');

      // Settings outside the root, or a key reached through a link out of it, are refused before anything runs.
      let spawned = false;
      const never = () => { spawned = true; return makeFakeChild(); };
      const outside = mkdtempSync(join(tmpdir(), 'keel-cred-outside-'));
      try {
        writeFileSync(join(outside, 'tenant.json'), JSON.stringify({ certPath: join(root, 'cert.pem'), keyPath: join(root, 'key.pem') }));
        await assert.rejects(() => runJob({ mode: 'probe', tenantConfigPath: join(outside, 'tenant.json') }, { spawnFn: never, credentialRoot: root, stagingRoot: staging }),
          (err) => err.code === 'CREDENTIALS_INVALID');
        writeFileSync(join(outside, 'stolen.pem'), 'X');
        symlinkSync(join(outside, 'stolen.pem'), join(root, 'link.pem'));
        writeFileSync(join(root, 'linked.json'), JSON.stringify({ certPath: join(root, 'cert.pem'), keyPath: join(root, 'link.pem') }));
        await assert.rejects(() => runJob({ mode: 'probe', tenantConfigPath: join(root, 'linked.json') }, { spawnFn: never, credentialRoot: root, stagingRoot: staging }),
          (err) => err.code === 'CREDENTIALS_INVALID' && /keyPath/.test(err.message));
        writeFileSync(join(root, 'nokey.json'), JSON.stringify({ certPath: join(root, 'cert.pem'), keyPath: join(root, 'missing.pem') }));
        await assert.rejects(() => runJob({ mode: 'probe', tenantConfigPath: join(root, 'nokey.json') }, { spawnFn: never, credentialRoot: root, stagingRoot: staging }),
          (err) => err.code === 'CREDENTIALS_INVALID');
        await assert.rejects(() => runJob({ mode: 'probe', tenantConfigPath: 'tenant.json' }, { spawnFn: never, credentialRoot: root, stagingRoot: staging }),
          (err) => err.code === 'CREDENTIALS_INVALID');
      } finally { rmSync(outside, { recursive: true, force: true }); }
      assert.equal(spawned, false, 'nothing runs when the credentials are refused');
      assert.deepEqual(readdirSync(staging), [], 'refused jobs leave nothing staged');

      // No settings file on this host: nothing is mounted and the job descriptor is unchanged.
      await runJob({ mode: 'probe', tenantConfigPath: join(root, 'absent.json') }, { spawnFn: (bin, a) => { args = a; const c = makeFakeChild({ stdoutChunks: ['[]'] }); sent = c.__written; return c; }, credentialRoot: root, stagingRoot: staging });
      assert.ok(!args.some((a) => String(a).endsWith(`:${CONTAINER_CREDENTIAL_DIR}:ro`)), 'no credential mount without settings');
      assert.equal(JSON.parse(sent.join('')).tenantConfigPath, join(root, 'absent.json'));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  }

  console.log('jobQueue.test.mjs — all assertions passed (offline, no Docker)');
}

await run();
