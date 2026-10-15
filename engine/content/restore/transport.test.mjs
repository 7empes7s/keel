import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { contentWriteTransport } from './transport.mjs';

const GRAPH = 'https://graph.microsoft.com/v1.0';
// A fake fetch: nothing here reaches a tenant.
function fakeFetch(responses = []) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, ...init });
    const next = responses.shift() ?? { status: 200, json: { ok: true } };
    return new Response(next.json === undefined ? null : JSON.stringify(next.json), { status: next.status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, impl };
}
const keelRtOnly = (url, { endpoint }) => endpoint.startsWith('/users/KEEL-RT-') || 'not a KEEL-RT- mailbox';

test('POST, PATCH, PUT and GET reach Graph with the token and a JSON body', async () => {
  const fetch = fakeFetch();
  const guarded = [];
  const transport = contentWriteTransport(() => 'token-1', fetch.impl, { guard: (url, request) => guarded.push([url, request]) && keelRtOnly(url, request) });
  for (const method of ['POST', 'PATCH', 'PUT', 'GET']) {
    const result = await transport(`${GRAPH}/users/KEEL-RT-a/messages`, method === 'GET' ? { method } : { method, body: { subject: 'x' } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true });
  }
  assert.deepEqual(fetch.calls.map((call) => call.method), ['POST', 'PATCH', 'PUT', 'GET']);
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer token-1');
  assert.equal(fetch.calls[0].headers['content-type'], 'application/json');
  assert.equal(fetch.calls[0].body, '{"subject":"x"}');
  assert.equal(fetch.calls[0].redirect, 'manual');
  assert.equal(fetch.calls[3].body, undefined);
  assert.deepEqual(guarded[0], [`${GRAPH}/users/KEEL-RT-a/messages`, { method: 'POST', endpoint: '/users/KEEL-RT-a/messages', body: { subject: 'x' } }]);
});

test('a string or byte body is sent as is with its content-type', async () => {
  const fetch = fakeFetch();
  const transport = contentWriteTransport(() => 't', fetch.impl, { guard: () => {} });
  await transport(`${GRAPH}/users/KEEL-RT-a/messages`, { method: 'POST', body: 'TUlNRQ==', headers: { 'content-type': 'text/plain' } });
  assert.equal(fetch.calls[0].body, 'TUlNRQ==');
  assert.equal(fetch.calls[0].headers['content-type'], 'text/plain');
  fetch.calls.length = 0;
  const bytes = Buffer.from('hello');
  await transport(`${GRAPH}/drives/d/root:/KEEL-RT-f.txt:/content`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(fetch.calls[0].body, bytes);
  assert.equal(fetch.calls[0].headers['content-type'], 'text/plain');
  await assert.rejects(transport(`${GRAPH}/drives/d/items/x/content`, { method: 'PUT', body: bytes }), /content-type/);
  await assert.rejects(transport(`${GRAPH}/users/KEEL-RT-a/messages`, { method: 'POST', body: 'TUlNRQ==' }), /content-type/);
});

test('DELETE and other methods are refused before anything is sent', async () => {
  const fetch = fakeFetch();
  const transport = contentWriteTransport(() => 't', fetch.impl, { guard: () => true });
  for (const method of ['DELETE', 'delete', 'HEAD', 'OPTIONS', 'MERGE']) {
    await assert.rejects(transport(`${GRAPH}/users/KEEL-RT-a/messages/1`, { method }), /never sends/);
  }
  assert.equal(fetch.calls.length, 0);
});

test('a host other than Graph is refused', async () => {
  const fetch = fakeFetch();
  const transport = contentWriteTransport(() => 't', fetch.impl, { guard: () => true });
  for (const url of [
    'https://contoso.sharepoint.com/_api/upload?guid=1',
    'https://graph.microsoft.com.evil.example/v1.0/users',
    'http://graph.microsoft.com/v1.0/users',
    'https://graph.microsoft.com:8443/v1.0/users',
    'https://login.microsoftonline.com/x',
  ]) {
    await assert.rejects(transport(url, { method: 'POST', body: {} }), /Microsoft Graph only/, url);
  }
  assert.equal(fetch.calls.length, 0);
});

test('a guard refusal, a missing guard and an unknown header are refused', async () => {
  const fetch = fakeFetch();
  assert.throws(() => contentWriteTransport(() => 't', fetch.impl), /target guard/);
  const transport = contentWriteTransport(() => 't', fetch.impl, { guard: keelRtOnly });
  await assert.rejects(transport(`${GRAPH}/users/ceo@contoso.com/messages`, { method: 'POST', body: {} }), /guard refused POST .*not a KEEL-RT- mailbox/);
  await assert.rejects(transport(`${GRAPH}/users/ceo@contoso.com/messages`), /guard refused GET/);
  const thrower = contentWriteTransport(() => 't', fetch.impl, { guard: (url) => { throw new Error(`not a KEEL-RT- target: ${url}`); } });
  await assert.rejects(thrower(`${GRAPH}/users/ceo@contoso.com/messages`, { method: 'POST', body: {} }), /not a KEEL-RT- target/);
  const refuser = contentWriteTransport(() => 't', fetch.impl, { guard: async () => false });
  await assert.rejects(refuser(`${GRAPH}/users/KEEL-RT-a/messages`, { method: 'POST', body: {} }), /guard refused/);
  await assert.rejects(transport(`${GRAPH}/users/KEEL-RT-a/messages`, { method: 'POST', body: {}, headers: { 'X-Forward': '1' } }), /request header/);
  await assert.rejects(transport(`${GRAPH}/users/KEEL-RT-a/messages`, { method: 'GET', body: {} }), /GET with a body/);
  assert.equal(fetch.calls.length, 0);
});

test('the token is renewed before it expires and once after a 401', async () => {
  let clock = 0;
  let issued = 0;
  const fetch = fakeFetch([{ status: 200, json: {} }, { status: 200, json: {} }, { status: 401, json: {} }, { status: 201, json: { id: 'm' } }]);
  const transport = contentWriteTransport(() => ({ accessToken: `t${++issued}`, expiresAt: clock + 10 * 60 * 1000 }), fetch.impl, {
    guard: () => true, now: () => clock,
  });
  await transport(`${GRAPH}/users/KEEL-RT-a/messages`, { method: 'POST', body: {} });
  clock = 6 * 60 * 1000;
  await transport(`${GRAPH}/users/KEEL-RT-a/messages`, { method: 'POST', body: {} });
  const result = await transport(`${GRAPH}/users/KEEL-RT-a/messages`, { method: 'POST', body: {} });
  assert.equal(result.status, 201);
  assert.deepEqual(fetch.calls.map((call) => call.headers.authorization), ['Bearer t1', 'Bearer t2', 'Bearer t2', 'Bearer t3']);
});

test('an upload session URL the transport was issued takes PUT chunks without the token', async () => {
  const uploadUrl = 'https://contoso.sharepoint.com/sites/KEEL-RT-s/_api/v2.0/drives/d/items/x/uploadSession?guid=1&tempauth=abc';
  const fetch = fakeFetch([{ status: 200, json: { uploadUrl } }, { status: 202, json: {} }, { status: 201, json: { id: 'f' } }]);
  const seen = [];
  const transport = contentWriteTransport(() => 'token-1', fetch.impl, { guard: (url) => { seen.push(url); } });
  const chunk = Buffer.from('abc');
  await assert.rejects(transport(uploadUrl, { method: 'PUT', body: chunk, headers: { 'Content-Range': 'bytes 0-2/6' } }), /Microsoft Graph only/);
  await transport(`${GRAPH}/drives/d/root:/KEEL-RT-big.bin:/createUploadSession`, { method: 'POST', body: {} });
  await assert.rejects(transport(uploadUrl, { method: 'PUT', body: chunk, headers: { authorization: 'Bearer x', 'Content-Range': 'bytes 0-2/6' } }), /upload header/);
  await assert.rejects(transport(uploadUrl, { method: 'PUT', body: chunk }), /content-range/);
  await assert.rejects(transport(uploadUrl, { method: 'POST', body: {} }), /Microsoft Graph only/);
  assert.equal((await transport(uploadUrl, { method: 'PUT', body: chunk, headers: { 'Content-Range': 'bytes 0-2/6' } })).status, 202);
  assert.equal((await transport(uploadUrl, { method: 'PUT', body: chunk, headers: { 'Content-Range': 'bytes 3-5/6' } })).status, 201);
  assert.deepEqual(fetch.calls[1].headers, { 'content-range': 'bytes 0-2/6' });
  assert.equal(fetch.calls[1].body, chunk);
  assert.ok(seen.includes(uploadUrl));
  // Once the upload completes the URL is forgotten.
  await assert.rejects(transport(uploadUrl, { method: 'PUT', body: chunk, headers: { 'Content-Range': 'bytes 0-2/6' } }), /Microsoft Graph only/);
  assert.equal(fetch.calls.length, 3);
});

test('an upload URL on a host other than SharePoint is never trusted', async () => {
  const fetch = fakeFetch([{ status: 200, json: { uploadUrl: 'https://evil.example/upload' } }]);
  const transport = contentWriteTransport(() => 't', fetch.impl, { guard: () => true });
  await transport(`${GRAPH}/drives/d/root:/KEEL-RT-big.bin:/createUploadSession`, { method: 'POST', body: {} });
  await assert.rejects(transport('https://evil.example/upload', { method: 'PUT', body: Buffer.from('a'), headers: { 'Content-Range': 'bytes 0-0/1' } }), /Microsoft Graph only/);
});
