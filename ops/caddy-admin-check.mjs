#!/usr/bin/env node
// Host check: Caddy's admin API must not answer on a TCP port.
//
//   node ops/caddy-admin-check.mjs [--config /etc/caddy/Caddyfile] [--port 2019]
//
// Caddy's admin API takes unauthenticated POSTs (/load, /stop, /config/...). By default it
// listens on localhost:2019, where any local process can rewrite or stop the web server
// (operator item Q195). The fix is a global `admin unix//run/caddy/admin.sock` (reloads keep
// working) or `admin off` (reloads need a restart). See ops/README.md, "Caddy admin API".
//
// Exit 0 when every check passes, 1 when one fails, 2 on bad usage. Read-only: it only
// connects to the port, never sends a request.
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONFIG = '/etc/caddy/Caddyfile';
export const DEFAULT_PORT = 2019;

// Strips a Caddyfile comment: `#` at the start of a line or after whitespace.
function stripComment(line) {
  return line.replace(/(^|\s)#.*$/, '').trim();
}

// Reads the global `admin` option from Caddyfile text.
// Returns { mode: 'default' } when there is no global block or no admin line,
// { mode: 'off' }, { mode: 'unix', path } or { mode: 'tcp', address }.
export function adminFromCaddyfile(text) {
  const lines = text.split(/\r?\n/).map(stripComment).filter(Boolean);
  if (lines[0] !== '{') return { mode: 'default' };
  let depth = 0;
  for (const line of lines) {
    if (depth === 1) {
      const [name, value] = line.split(/\s+/);
      if (name === 'admin') return adminFromValue(value);
    }
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    if (depth === 0) break;
  }
  return { mode: 'default' };
}

// Reads the `admin` object from Caddy's JSON config (the output of `caddy adapt`).
export function adminFromJson(config) {
  const admin = config?.admin;
  if (!admin) return { mode: 'default' };
  if (admin.disabled === true) return { mode: 'off' };
  return admin.listen ? adminFromValue(admin.listen) : { mode: 'default' };
}

function adminFromValue(value) {
  if (!value) return { mode: 'default' };
  const v = value.replace(/^"|"$/g, '');
  if (v === 'off') return { mode: 'off' };
  // `unix//path` or `unix//path|0600` (the suffix is the socket's file mode).
  if (v.startsWith('unix/')) return { mode: 'unix', path: v.slice('unix/'.length).split('|')[0] };
  return { mode: 'tcp', address: v };
}

// Uses `caddy adapt` when the binary is there (it resolves imports and env placeholders),
// and falls back to reading the Caddyfile text.
export function readAdmin(configPath, { caddy = 'caddy' } = {}) {
  try {
    const out = execFileSync(caddy, ['adapt', '--config', configPath], { stdio: ['ignore', 'pipe', 'ignore'] });
    return { ...adminFromJson(JSON.parse(out.toString())), source: 'caddy adapt' };
  } catch {
    return { ...adminFromCaddyfile(readFileSync(configPath, 'utf8')), source: 'Caddyfile text' };
  }
}

// Resolves true when something accepts a TCP connection on host:port. Sends nothing.
export function portOpen(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Runs every check and returns [{ ok, message }].
export async function check({ config = DEFAULT_CONFIG, port = DEFAULT_PORT, caddy = 'caddy' } = {}) {
  const results = [];
  let admin;
  try {
    admin = readAdmin(config, { caddy });
  } catch (err) {
    return [{ ok: false, message: `cannot read ${config}: ${err.code || err.message}` }];
  }
  if (admin.mode === 'off') {
    results.push({ ok: true, message: `${config} sets admin off (${admin.source}); reloads need a restart` });
  } else if (admin.mode === 'unix') {
    results.push({ ok: true, message: `${config} puts the admin API on unix socket ${admin.path} (${admin.source})` });
    const dir = dirname(admin.path);
    try {
      const mode = statSync(dir).mode & 0o777;
      const ok = (mode & 0o077) === 0;
      results.push({
        ok,
        message: `socket directory ${dir} is mode ${mode.toString(8).padStart(4, '0')}${ok ? '' : ' (expected 0700: other users can reach the socket)'}`,
      });
    } catch (err) {
      results.push({ ok: false, message: `socket directory ${dir} is missing (${err.code}); Caddy cannot create the socket` });
    }
  } else if (admin.mode === 'tcp') {
    results.push({ ok: false, message: `${config} puts the admin API on TCP ${admin.address} (${admin.source}); use admin unix//... or admin off` });
  } else {
    results.push({ ok: false, message: `${config} has no global admin option (${admin.source}), so Caddy listens on localhost:${DEFAULT_PORT}` });
  }
  for (const host of ['127.0.0.1', '::1']) {
    const open = await portOpen(host, port);
    results.push({
      ok: !open,
      message: open ? `something accepts connections on ${host} port ${port}` : `nothing listens on ${host} port ${port}`,
    });
  }
  return results;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--config' && value) { opts.config = value; i += 1; }
    else if (flag === '--port' && /^\d+$/.test(value || '')) { opts.port = Number(value); i += 1; }
    else if (flag === '--caddy' && value) { opts.caddy = value; i += 1; }
    else return null;
  }
  return opts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.error('usage: node ops/caddy-admin-check.mjs [--config PATH] [--port N] [--caddy BIN]');
    process.exit(2);
  }
  const results = await check(opts);
  for (const r of results) (r.ok ? console.log : console.error)(`${r.ok ? 'PASS' : 'FAIL'}: ${r.message}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
