// engine/notify/channels/sms.mjs
//
// Roadmap task-84: SMS. The provider is explicit configuration and only Twilio is
// implemented; any other provider is refused when the channel is created, and a stored
// channel naming one stays unconfigured (nothing is sent).
//
// Contract (as implemented; see docs/roadmap/notification-adapters.md): POST a form to
// /2010-04-01/Accounts/{AccountSid}/Messages.json with HTTP Basic auth (account SID and
// auth token); 201 with a message `sid` and status `queued`/`accepted` means Twilio
// took the message. Delivery to the handset is asynchronous and is not tracked here.
// 429 (error 20429) is throttling; a 400 carries a numeric error code.
import { capText, configProblems, eventSummary, httpOutcome, parseJson, snippet } from './common.mjs';

export const PROVIDER = 'twilio';
export const LABEL = 'Text message';
export const SEMANTICS = 'Accepted by Twilio for sending. KEEL does not track delivery to the phone.';
export const SUPPORTED_PROVIDERS = Object.freeze(['twilio']);

const E164 = /^\+[1-9]\d{6,14}$/;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
// Two concatenated segments: enough for a summary, bounded in cost.
const BODY_LIMIT = 320;

export function validateConfig(config) {
  if (config.provider === undefined) return [`provider is required (supported: ${SUPPORTED_PROVIDERS.join(', ')})`];
  if (!SUPPORTED_PROVIDERS.includes(config.provider)) {
    return [`SMS provider ${String(config.provider)} is not supported (supported: ${SUPPORTED_PROVIDERS.join(', ')})`];
  }
  const problems = configProblems(config, {
    references: ['authTokenRef'], allowed: ['provider', 'accountSid', 'from', 'messagingServiceSid', 'to'],
  });
  if (!ACCOUNT_SID.test(String(config.accountSid ?? ''))) problems.push('accountSid must be a Twilio account SID (AC followed by 32 hex characters)');
  if (config.from === undefined && config.messagingServiceSid === undefined) problems.push('from or messagingServiceSid is required');
  if (config.from !== undefined && !E164.test(String(config.from))) problems.push('from must be a phone number in E.164 form, such as +15551230000');
  if (config.messagingServiceSid !== undefined && !SERVICE_SID.test(String(config.messagingServiceSid))) problems.push('messagingServiceSid must start with MG');
  if (!E164.test(String(config.to ?? ''))) problems.push('to must be one phone number in E.164 form, such as +15551230000');
  return problems;
}

export async function prepare({ config, event, secret }) {
  const token = await secret(config.authTokenRef);
  if (!token) return { unconfigured: `the credential reference ${config.authTokenRef} has no value` };
  const url = new URL(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`);
  const basic = Buffer.from(`${config.accountSid}:${token}`).toString('base64');
  const form = new URLSearchParams({ To: config.to, Body: capText(eventSummary(event), BODY_LIMIT) });
  if (config.messagingServiceSid) form.set('MessagingServiceSid', config.messagingServiceSid);
  else form.set('From', config.from);
  return {
    url,
    endpointHost: url.hostname,
    secrets: [token, basic],
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
      body: form.toString(),
    },
  };
}

export function interpret({ status, body }) {
  const outcome = httpOutcome(status);
  const json = parseJson(body);
  if (outcome === 'delivered') {
    return { outcome, receipt: { providerMessageId: json?.sid ?? null, providerStatus: json?.status ?? null } };
  }
  const code = json?.code ? ` error ${json.code}` : '';
  if (outcome === 'retry') return { outcome, detail: `provider is throttling or unavailable (HTTP ${status}${code})` };
  if (status === 401) return { outcome, detail: 'provider refused the credentials (HTTP 401)' };
  return { outcome, detail: `provider refused the message (HTTP ${status}${code})${json?.message ? `: ${snippet(json.message)}` : ''}` };
}
