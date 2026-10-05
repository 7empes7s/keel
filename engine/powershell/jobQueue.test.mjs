// Offline unit test for jobQueue.mjs — stubs the container invocation via the
// injectable `spawnFn`, so this runs with no Docker daemon and no network.
//
//   cd /opt/keel && node engine/powershell/jobQueue.test.mjs

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { runJob, JobQueueError, DEFAULT_MEMORY } from './jobQueue.mjs';

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

    assert.ok(
      capturedArgs.some((a) => a === '-v') &&
      capturedArgs.some((a) => typeof a === 'string' && a.startsWith('/etc/keel:/etc/keel:ro')),
      '/etc/keel must be mounted read-only',
    );
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

  console.log('jobQueue.test.mjs — all assertions passed (offline, no Docker)');
}

await run();
