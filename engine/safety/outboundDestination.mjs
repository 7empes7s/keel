// engine/safety/outboundDestination.mjs
//
// Security audit finding 6: admins choose the address of a notify webhook and of a SIEM
// webhook, and the worker that sends them runs as root on the deploy host. Without a
// rule, a webhook can reach services that only listen on the host itself (for example
// a reverse proxy admin API on 127.0.0.1), the cloud metadata address or the private
// network. This module is that rule:
//
//  - Only public addresses are allowed. Loopback, private, link-local (which holds the
//    metadata address 169.254.169.254), carrier-grade NAT, multicast, documentation,
//    benchmark and reserved ranges are refused, for IPv4 and IPv6, including IPv4
//    written inside IPv6.
//  - The check runs on the address the connection actually uses: a DNS name is checked
//    inside the socket's own lookup, so a name cannot pass the check and then resolve
//    somewhere else when the connection opens.
//  - Redirects are followed by hand, a few at most, and every hop is checked the same
//    way. An Authorization header is not carried to another origin.
//  - `allowLoopback` lets tests talk to a listener on 127.0.0.1 or ::1. Production code
//    never passes it.
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';

export const OUTBOUND_MAX_REDIRECTS = 3;
const RESPONSE_BODY_LIMIT = 64 * 1024;

export class BlockedDestinationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedDestinationError';
    this.code = 'KEEL_BLOCKED_DESTINATION';
  }
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, holds the cloud metadata address
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes broadcast
]) NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
]) NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');

function hextets(ipv6) {
  let [head, tail] = ipv6.split('::');
  const toGroups = (part) => (part ? part.split(':') : []);
  let headGroups = toGroups(head);
  let tailGroups = tail === undefined ? [] : toGroups(tail);
  // A trailing dotted IPv4 becomes two groups.
  const fix = (groups) => {
    const last = groups.at(-1);
    if (last && last.includes('.')) {
      const [a, b, c, d] = last.split('.').map(Number);
      groups.splice(-1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
    }
    return groups;
  };
  headGroups = fix(headGroups);
  tailGroups = fix(tailGroups);
  const missing = 8 - headGroups.length - tailGroups.length;
  const all = tail === undefined ? headGroups : [...headGroups, ...Array(missing).fill('0'), ...tailGroups];
  return all.map((group) => parseInt(group, 16));
}

/** The IPv4 address an IPv4-mapped IPv6 address (::ffff:a.b.c.d) stands for, else null. */
function mappedIpv4(ipv6) {
  const groups = hextets(ipv6);
  if (groups.length !== 8 || groups.slice(0, 5).some((g) => g !== 0) || groups[5] !== 0xffff) return null;
  return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
}

/** Why an IP address may not be used, or null when it is a public address. */
export function addressProblem(address, { allowLoopback = false } = {}) {
  const raw = String(address ?? '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  let family = isIP(raw);
  if (family === 0) return `${raw || 'the address'} is not an IP address`;
  let ip = raw;
  if (family === 6) {
    const v4 = mappedIpv4(raw);
    if (v4) { ip = v4; family = 4; }
    // IPv4-translated (::ffff:0:a.b.c.d) is never a public destination. It is checked
    // here because BlockList folds IPv4 into ::ffff:0:0/96 and would match every IPv4.
    const groups = hextets(raw);
    if (!v4 && groups.slice(0, 4).every((g) => g === 0) && groups[4] === 0xffff && groups[5] === 0) {
      return `${raw} is a private, local or reserved address; Keel only sends to public addresses`;
    }
  }
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (allowLoopback && LOOPBACK.check(ip, type)) return null;
  if (NOT_PUBLIC.check(ip, type)) {
    return `${raw} is a private, local or reserved address; Keel only sends to public addresses`;
  }
  return null;
}

/**
 * Check a URL before any request: the scheme, and the host when it is written as an IP
 * address or as localhost. A DNS name is checked again when the connection opens.
 */
export function assertDestinationAllowed(url, { allowLoopback = false, protocols = ['http:', 'https:'] } = {}) {
  const parsed = url instanceof URL ? url : new URL(String(url));
  if (!protocols.includes(parsed.protocol)) {
    throw new BlockedDestinationError(`the address must use ${protocols.map((p) => p.replace(':', '')).join(' or ')}`);
  }
  if (parsed.username || parsed.password) {
    throw new BlockedDestinationError('the address must not contain a user name or password');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) {
    const problem = addressProblem(host, { allowLoopback });
    if (problem) throw new BlockedDestinationError(problem);
  } else if (host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.') {
    if (!allowLoopback) throw new BlockedDestinationError(`${host} is a local address; Keel only sends to public addresses`);
  }
  return parsed;
}

/** A socket lookup that refuses the connection when any resolved address is not public. */
export function guardedLookup({ allowLoopback = false, resolve = dnsLookup } = {}) {
  return function lookup(hostname, options, callback) {
    const opts = typeof options === 'function' ? {} : (typeof options === 'number' ? { family: options } : options ?? {});
    const done = typeof options === 'function' ? options : callback;
    resolve(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) return done(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: isIP(addresses) }];
      if (list.length === 0) return done(new Error(`${hostname} did not resolve to any address`));
      for (const { address } of list) {
        const problem = addressProblem(address, { allowLoopback });
        if (problem) return done(new BlockedDestinationError(`${hostname} resolves to ${problem}`));
      }
      if (opts.all) return done(null, list);
      return done(null, list[0].address, list[0].family);
    });
  };
}

function headerLookup(headers) {
  return {
    get(name) {
      const value = headers[String(name).toLowerCase()];
      if (value === undefined) return null;
      return Array.isArray(value) ? value.join(', ') : String(value);
    },
  };
}

function requestOnce(url, { method, headers, body, signal, lookup }) {
  const transport = url.protocol === 'https:' ? https : http;
  const sendHeaders = { ...headers };
  if (body !== undefined && body !== null
    && !Object.keys(sendHeaders).some((key) => key.toLowerCase() === 'content-length')) {
    sendHeaders['content-length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method, headers: sendHeaders, signal, lookup, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (size < RESPONSE_BODY_LIMIT) chunks.push(chunk);
        size += chunk.length;
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).subarray(0, RESPONSE_BODY_LIMIT).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * A small fetch-like request that only reaches public addresses. Returns
 * `{ status, ok, headers: { get }, text() }`. Throws BlockedDestinationError when the
 * address, or any redirect hop, is not allowed.
 */
export async function guardedRequest(target, {
  method = 'POST', headers = {}, body, signal, allowLoopback = false,
  protocols = ['http:', 'https:'], maxRedirects = OUTBOUND_MAX_REDIRECTS, resolve,
} = {}) {
  const lookup = guardedLookup({ allowLoopback, resolve });
  let url = assertDestinationAllowed(target, { allowLoopback, protocols });
  let current = { method, headers: { ...headers }, body };
  for (let hop = 0; ; hop += 1) {
    const response = await requestOnce(url, { ...current, signal, lookup });
    const location = response.headers.location;
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        headers: headerLookup(response.headers),
        text: async () => response.body,
      };
    }
    if (hop >= maxRedirects) throw new BlockedDestinationError(`the address redirected more than ${maxRedirects} times`);
    let next;
    try {
      next = new URL(location, url);
    } catch {
      throw new BlockedDestinationError('the address redirected to an invalid address');
    }
    next = assertDestinationAllowed(next, { allowLoopback, protocols });
    const nextHeaders = { ...current.headers };
    if (next.origin !== url.origin) {
      for (const key of Object.keys(nextHeaders)) {
        if (['authorization', 'cookie', 'proxy-authorization'].includes(key.toLowerCase())) delete nextHeaders[key];
      }
    }
    // Same rules as fetch: 307 and 308 keep the method and body, the others become GET.
    current = [307, 308].includes(response.status)
      ? { ...current, headers: nextHeaders }
      : { method: 'GET', headers: withoutBodyHeaders(nextHeaders), body: undefined };
    url = next;
  }
}

function withoutBodyHeaders(headers) {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (['content-type', 'content-length'].includes(key.toLowerCase())) delete out[key];
  }
  return out;
}

// Credential references for integrations that send to an admin-chosen address must name
// an environment variable in the integration namespace, so a reference can never pick
// up the database URL or any other secret the worker happens to hold.
export const INTEGRATION_ENV_PREFIX = 'KEEL_INTEGRATION_';
const INTEGRATION_REFERENCE = /^env:KEEL_INTEGRATION_[A-Z0-9_]+$/;

export function isIntegrationReference(value) {
  return typeof value === 'string' && INTEGRATION_REFERENCE.test(value);
}
