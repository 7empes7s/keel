#!/usr/bin/env node
/**
 * Pre-consent diagnostic.
 *
 * Runs before any permission has been granted, because the token endpoint
 * already distinguishes the failure modes that look identical in the portal:
 * a missing Microsoft Graph service principal, a wrong client id, a
 * certificate that was never uploaded, and a tenant that simply has nothing
 * licensed. Each produces a different AADSTS code, and guessing between them
 * wastes a portal round-trip per guess.
 *
 *   node preflight.mjs --tenant <id-or-domain> --client <app-id> [--cert path --key path]
 */

import { getToken, decodeRoles } from './auth.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const tenantId = arg('tenant');
const clientId = arg('client');
const certPath = arg('cert', '/etc/keel/keel-collector.cer');
const keyPath = arg('key', '/etc/keel/keel-collector.key');

if (!tenantId || !clientId) {
  console.error('usage: node preflight.mjs --tenant <id> --client <app-id> [--cert p --key p]');
  process.exit(2);
}

/** AADSTS codes that each point at exactly one cause and one fix. */
const DIAGNOSES = [
  {
    code: 'AADSTS500011',
    cause: 'The Microsoft Graph service principal does not exist in this tenant.',
    detail:
      'Graph is a first-party app, but every tenant needs its own service principal for it\n' +
      '  before permissions can be granted against it. Fresh tenants — especially ones created\n' +
      '  through an Azure subscription rather than an M365 signup — often ship without it.',
    fix:
      'Create it once, from Azure Cloud Shell (portal, top bar, >_ icon):\n\n' +
      '    az ad sp create --id 00000003-0000-0000-c000-000000000000\n\n' +
      '  Then re-grant admin consent. This is the cause of the portal error\n' +
      '  "your organization does not have a subscription (or service principal) for Microsoft Graph".',
  },
  {
    code: 'AADSTS700016',
    cause: 'No application with that client id exists in this tenant.',
    fix: 'Check the Application (client) ID on the app registration overview blade — not the Object ID, and not the Directory ID.',
  },
  {
    code: 'AADSTS700027',
    cause: 'The client assertion signature was rejected — the certificate is not on this app registration.',
    fix: 'Upload the .cer under Certificates & secrets → Certificates, and confirm the thumbprint Entra displays matches the one we generated.',
  },
  {
    code: 'AADSTS50027',
    cause: 'The client assertion was malformed or its certificate is unknown to this app.',
    fix: 'Confirm the .cer was uploaded to THIS app registration, and that cert and key are the matching pair.',
  },
  {
    code: 'AADSTS7000215',
    cause: 'A client secret was expected — this app is not configured for certificate auth.',
    fix: 'Upload the certificate; do not create a secret.',
  },
  {
    code: 'AADSTS90002',
    cause: 'The tenant was not found.',
    fix: 'Check the Directory (tenant) ID.',
  },
  {
    code: 'AADSTS900023',
    cause: 'The tenant identifier is not valid.',
    fix: 'Use the Directory (tenant) GUID or a verified domain name.',
  },
];

async function tenantExists() {
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`,
  );
  if (!res.ok) return { ok: false, status: res.status };
  const doc = await res.json();
  return { ok: true, issuer: doc.issuer, region: doc.tenant_region_scope };
}

async function main() {
  console.log('KEEL preflight — pre-consent diagnostic\n');

  process.stdout.write('1. Tenant reachable                    ');
  const t = await tenantExists();
  if (!t.ok) {
    console.log(`✗ discovery returned ${t.status}`);
    console.log('\n   The tenant id or domain is wrong, or the tenant does not exist.');
    process.exit(1);
  }
  console.log(`✓ ${t.issuer}`);
  console.log(`   region scope: ${t.region ?? 'unknown'}`);

  process.stdout.write('\n2. Certificate auth + Graph resource   ');
  try {
    const token = await getToken({ tenantId, clientId, certPath, keyPath });
    const granted = decodeRoles(token.accessToken);
    console.log('✓ token issued');
    console.log(`   app id  : ${granted.appId}`);
    console.log(`   tenant  : ${granted.tenantId}`);
    console.log(`   roles   : ${granted.roles.length}`);

    if (granted.roles.length === 0) {
      console.log('\n   Auth works and the Graph service principal exists — but no application');
      console.log('   permissions are consented, so every read will return 403.');
      console.log('   Grant admin consent on the app registration, then re-run.');
      process.exit(3);
    }
    for (const r of granted.roles) console.log(`     · ${r}`);
    console.log('\n   Ready. Run: node probe.mjs');
  } catch (err) {
    console.log('✗');
    const msg = err.message;
    const hit = DIAGNOSES.find((d) => msg.includes(d.code));
    console.log(`\n   ${msg.split('\n')[0]}\n`);
    if (hit) {
      console.log(`   Cause: ${hit.cause}`);
      if (hit.detail) console.log(`  ${hit.detail}`);
      console.log(`\n   Fix: ${hit.fix}`);
    } else {
      console.log('   No known diagnosis for this code — the raw error above is the evidence.');
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`preflight failed: ${e.message}`);
  process.exit(1);
});
