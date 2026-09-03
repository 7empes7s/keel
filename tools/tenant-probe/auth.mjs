/**
 * Certificate-based client-credentials auth for Microsoft Graph.
 *
 * Hand-rolled rather than using @azure/identity so that every HTTP interaction
 * with Graph is visible to the probe. The SDK transparently retries throttled
 * requests, which would destroy the throttling measurements this probe exists
 * to collect.
 */

import { createSign, createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Extract the DER bytes of a PEM certificate so we can compute the SHA-1
 * thumbprint Entra expects in the `x5t` JWT header.
 */
function certThumbprint(pemPath) {
  const pem = readFileSync(pemPath, 'utf8');
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(body, 'base64');
  return createHash('sha1').update(der).digest();
}

function clientAssertion({ tenantId, clientId, certPath, keyPath }) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    x5t: b64url(certThumbprint(certPath)),
  };
  const payload = {
    aud: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    iss: clientId,
    sub: clientId,
    jti: randomUUID(),
    nbf: now - 60,
    exp: now + 540,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(readFileSync(keyPath, 'utf8'));

  return `${signingInput}.${b64url(signature)}`;
}

export async function getToken({ tenantId, clientId, certPath, keyPath }) {
  const body = new URLSearchParams({
    client_id: clientId,
    scope: 'https://graph.microsoft.com/.default',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: clientAssertion({ tenantId, clientId, certPath, keyPath }),
    grant_type: 'client_credentials',
  });

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      `Token request failed (${res.status}): ${json.error} — ${json.error_description ?? 'no description'}`,
    );
  }
  return { accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
}

/**
 * Decode the token payload to report which application permissions were
 * actually granted. Consent failures are the single most common cause of a
 * probe reporting "0 objects" for a resource type that is in fact populated,
 * so we surface the granted roles explicitly rather than inferring from errors.
 */
export function decodeRoles(accessToken) {
  const [, payload] = accessToken.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  return {
    roles: (claims.roles ?? []).sort(),
    appId: claims.appid,
    tenantId: claims.tid,
  };
}
