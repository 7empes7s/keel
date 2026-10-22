// Discovery: the Get cmdlets each PowerShell module offers, listed live on the host.
//
// One container job per session (ops/powershell/list-commands.ps1). Exchange Online
// and Security & Compliance only build their cmdlets once a session connects, so both
// sessions are listed and merged under ExchangeOnlineManagement; the module counts as
// listed only when both answered, so a half list never hides compliance cmdlets.
// Cmdlets are listed, never run.
import { JobQueueError, parseJobStdout, runJob } from '../powershell/jobQueue.mjs';

export const COMMAND_SESSIONS = Object.freeze([
  { session: 'exo', module: 'ExchangeOnlineManagement' },
  { session: 'ipps', module: 'ExchangeOnlineManagement' },
  { session: 'teams', module: 'MicrosoftTeams' },
  { session: 'pnp', module: 'PnP.PowerShell' },
]);

// Connect-IPPSSession can take a minute on its own; one listing never needs five.
export const LIST_TIMEOUT_MS = 3 * 60 * 1000;
const GET_CMDLET = /^Get-[A-Za-z0-9]+$/;
const clip = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

function envelopeOf(stdout) {
  try {
    const value = parseJobStdout(stdout ?? '').value;
    return value && typeof value === 'object' && !Array.isArray(value) && typeof value.ok === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

/** One session's cmdlet names, or throws an Error whose message says why not. */
async function listSession(session, { runJobFn, tenantConfigPath, timeoutMs }) {
  let envelope;
  try {
    const ran = await runJobFn({ adapter: 'powershell/commands', mode: 'commands', session, ...(tenantConfigPath ? { tenantConfigPath } : {}) }, { timeoutMs });
    envelope = ran?.result && typeof ran.result === 'object' && typeof ran.result.ok === 'boolean' ? ran.result : null;
  } catch (error) {
    if (!(error instanceof JobQueueError)) throw new Error(clip(error?.message ?? error));
    const failed = envelopeOf(error.stdout);
    if (failed?.ok === false) throw new Error(clip(failed.error?.message ?? 'the listing failed'));
    if (error.code === 'TIMEOUT') throw new Error(`the listing took longer than ${Math.round(timeoutMs / 60000)} minutes`);
    if (error.code === 'SPAWN_ERROR' || error.code === 'SCRIPTS_MISSING') throw new Error('the PowerShell container could not be started');
    throw new Error(clip(error.message));
  }
  if (!envelope) throw new Error('the PowerShell container gave no command list');
  if (envelope.ok !== true) throw new Error(clip(envelope.error?.message ?? 'the listing failed'));
  const names = Array.isArray(envelope.commands) ? envelope.commands.filter((name) => typeof name === 'string' && GET_CMDLET.test(name)) : [];
  if (!names.length) throw new Error('the module listed no Get cmdlets');
  return names;
}

/**
 * Lists every module's Get cmdlets. Resolves
 *   { commands: { [module]: [name, ...] }, errors: { [module]: reason } }
 * A module appears in exactly one of the two. Sessions run one after another: each is
 * a container with its own memory cap, and the host is small.
 */
export async function listPowerShellCommands({ runJobFn = runJob, tenantConfigPath = null, timeoutMs = LIST_TIMEOUT_MS, sessions = COMMAND_SESSIONS } = {}) {
  const lists = new Map();
  const errors = {};
  for (const { session, module } of sessions) {
    if (errors[module]) continue;
    try {
      const names = await listSession(session, { runJobFn, tenantConfigPath, timeoutMs });
      lists.set(module, [...(lists.get(module) ?? []), ...names]);
    } catch (error) {
      errors[module] = `${session === 'ipps' ? 'Security & Compliance' : session === 'exo' ? 'Exchange Online' : module}: ${error.message}`;
      lists.delete(module);
    }
  }
  const commands = {};
  for (const [module, names] of lists) commands[module] = [...new Set(names)].sort();
  return { commands, errors };
}
