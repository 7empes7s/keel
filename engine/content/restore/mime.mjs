/**
 * Turns a backed-up MIME message into a Graph message create payload that Exchange stores
 * as a received (sent) message, not a draft (#293).
 *
 * Graph creates every message posted as MIME as a draft, and PR_MESSAGE_FLAGS cannot be
 * changed once the message exists. A message created from JSON can carry its MAPI
 * properties at creation, so the restore rebuilds the message from its MIME (subject,
 * addresses, body, attachments) and sets:
 *  - PR_MESSAGE_FLAGS (0x0E07) = read, not unsent;
 *  - PR_MESSAGE_DELIVERY_TIME (0x0E06) and PR_CLIENT_SUBMIT_TIME (0x0039), the received
 *    and sent times;
 *  - PR_INTERNET_MESSAGE_ID (0x1035) and PR_TRANSPORT_MESSAGE_HEADERS (0x007D), the
 *    original Message-ID and header block.
 *
 * Some messages keep the MIME create instead (and so restore as a draft), with the reason:
 * a signed or encrypted message (rebuilding it would break the signature), and one whose
 * payload is over the Graph request limit.
 */

export const MAX_JSON_PAYLOAD_BYTES = 3_500_000;
export const MSGFLAG_READ = 1;

const PROP = Object.freeze({
  flags: 'Integer 0x0E07',
  delivered: 'SystemTime 0x0E06',
  submitted: 'SystemTime 0x0039',
  messageId: 'String 0x1035',
  headers: 'String 0x007D',
});

// Some Node builds decode windows-1252 as plain Latin-1; mail labelled Latin-1 is
// windows-1252 in practice (WHATWG), so 0x80-0x9F are mapped here.
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
const LATIN1_LABELS = new Set(['windows-1252', 'cp1252', 'iso-8859-1', 'iso8859-1', 'latin1', 'l1']);

const decodeText = (bytes, charset = 'utf-8') => {
  const label = String(charset || 'utf-8').trim().toLowerCase();
  if (LATIN1_LABELS.has(label)) {
    return Array.from(Buffer.from(bytes), (byte) => (byte >= 0x80 && byte <= 0x9f ? CP1252[byte - 0x80] : String.fromCharCode(byte))).join('');
  }
  try { return new TextDecoder(label === 'us-ascii' || label === 'ascii' ? 'utf-8' : label).decode(bytes); } catch { return Buffer.from(bytes).toString('latin1'); }
};

/** Header bytes as text: UTF-8 when valid (RFC 6532), else Latin-1. */
const headerText = (bytes) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return Buffer.from(bytes).toString('latin1'); }
};

/** Splits an entity into its raw header block and body. */
function splitEntity(buf) {
  const text = buf.toString('latin1');
  const crlf = text.indexOf('\r\n\r\n');
  const lf = text.indexOf('\n\n');
  if (crlf < 0 && lf < 0) return { head: buf, body: Buffer.alloc(0) };
  const [at, gap] = crlf >= 0 && (lf < 0 || crlf <= lf) ? [crlf, 4] : [lf, 2];
  return { head: buf.subarray(0, at), body: buf.subarray(at + gap) };
}

/** [[lowercase name, value], ...] in order, unfolded. */
function parseHeaders(head) {
  const out = [];
  for (const line of headerText(head).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) out.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return out;
}

const header = (headers, name) => headers.find(([key]) => key === name)?.[1] ?? null;

/** RFC 2047 encoded words. */
export function decodeWords(value) {
  if (!value) return value ?? '';
  return value
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?[^?]+\?[bBqQ]\?[^?]*\?=)/g, '$1')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, encoding, data) => {
      const bytes = encoding.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
      return decodeText(bytes, charset.split('*')[0]);
    });
}

/** Splits on `sep` outside quotes, angle brackets and comments. */
function splitOutside(value, sep) {
  const parts = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && quoted) { current += c + (value[i + 1] ?? ''); i++; continue; }
    if (c === '"' && !paren) quoted = !quoted;
    else if (!quoted && c === '(') paren++;
    else if (!quoted && c === ')' && paren) paren--;
    else if (!quoted && !paren && c === '<') angle++;
    else if (!quoted && !paren && c === '>' && angle) angle--;
    if (c === sep && !quoted && !angle && !paren) { parts.push(current); current = ''; } else current += c;
  }
  parts.push(current);
  return parts;
}

/** "value; a=b; c*=utf-8''x" -> { value, params } (RFC 2045 and 2231). */
function parseParams(raw) {
  const [first, ...rest] = splitOutside(raw ?? '', ';');
  const params = {};
  const pieces = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(name);
    if (!m) continue;
    (pieces[m[1]] ??= []).push({ index: Number(m[2] ?? 0), encoded: Boolean(m[3]), value });
  }
  for (const [name, list] of Object.entries(pieces)) {
    list.sort((a, b) => a.index - b.index);
    let charset = 'utf-8';
    const bytes = [];
    for (const [n, piece] of list.entries()) {
      let { value } = piece;
      if (piece.encoded) {
        if (n === 0) {
          const m = /^([^']*)'[^']*'(.*)$/.exec(value);
          if (m) { charset = m[1] || charset; value = m[2]; }
        }
        bytes.push(Buffer.from(value.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1'));
      } else {
        bytes.push(Buffer.from(value, 'utf8'));
      }
    }
    const joined = Buffer.concat(bytes);
    params[name] = list.some((piece) => piece.encoded) ? decodeText(joined, charset) : decodeWords(joined.toString('utf8'));
  }
  return { value: first.trim().toLowerCase(), params };
}

/** An address list header -> [{ emailAddress: { name?, address } }]. */
export function parseAddresses(value) {
  if (!value) return [];
  const out = [];
  for (let part of splitOutside(value, ',')) {
    // A group ("Team: a@x, b@x;") keeps its members.
    const colon = splitOutside(part, ':');
    if (colon.length > 1 && !/<[^>]*$/.test(colon[0])) part = colon.slice(1).join(':');
    part = part.replace(/;\s*$/, '').trim();
    if (!part) continue;
    let name = '';
    let address;
    const angle = /<([^>]*)>\s*$/.exec(part);
    if (angle) {
      address = angle[1].trim();
      name = part.slice(0, angle.index).trim();
    } else {
      const comment = /\(([^)]*)\)/.exec(part);
      address = part.replace(/\([^)]*\)/g, '').trim();
      name = comment?.[1]?.trim() ?? '';
    }
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
    name = decodeWords(name).trim();
    if (!address) continue;
    out.push({ emailAddress: name && name !== address ? { name, address } : { address } });
  }
  return out;
}

const toIso = (value) => {
  if (!value) return null;
  const date = new Date(value.replace(/\([^)]*\)/g, '').trim());
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
};

function decodeBody(body, encoding) {
  const kind = String(encoding ?? '').trim().toLowerCase();
  if (kind === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (kind === 'quoted-printable') {
    return Buffer.from(body.toString('latin1').replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
  }
  return body;
}

function splitMultipart(body, boundary) {
  const text = body.toString('latin1');
  const delimiter = `--${boundary}`;
  const parts = [];
  let start = -1;
  let at = 0;
  for (;;) {
    const found = text.indexOf(delimiter, at);
    if (found < 0) break;
    const lineStart = found === 0 || text[found - 1] === '\n';
    if (!lineStart) { at = found + delimiter.length; continue; }
    if (start >= 0) parts.push(body.subarray(start, found - (text[found - 2] === '\r' ? 2 : 1)));
    const closing = text.startsWith('--', found + delimiter.length);
    if (closing) return parts;
    const eol = text.indexOf('\n', found);
    if (eol < 0) break;
    start = eol + 1;
    at = start;
  }
  if (start >= 0) parts.push(body.subarray(start));
  return parts;
}

/** Walks the entity tree, collecting the first text and HTML bodies and every attachment. */
function walk(buf, found, depth = 0) {
  const { head, body } = splitEntity(buf);
  const headers = parseHeaders(head);
  const type = parseParams(header(headers, 'content-type') ?? 'text/plain');
  const disposition = parseParams(header(headers, 'content-disposition') ?? '');
  if (type.value.startsWith('multipart/') && type.params.boundary && depth < 20) {
    for (const part of splitMultipart(body, type.params.boundary)) walk(part, found, depth + 1);
    return;
  }
  const content = decodeBody(body, header(headers, 'content-transfer-encoding'));
  const filename = disposition.params.filename ?? type.params.name ?? null;
  const contentId = header(headers, 'content-id')?.replace(/^<|>$/g, '') ?? null;
  const isText = type.value === 'text/plain' || type.value === 'text/html';
  if (isText && disposition.value !== 'attachment' && !filename) {
    const slot = type.value === 'text/html' ? 'html' : 'text';
    if (found[slot] === null) { found[slot] = decodeText(content, type.params.charset); return; }
  }
  const fallbackName = type.value === 'message/rfc822' ? 'message.eml'
    : type.value === 'text/calendar' ? 'invite.ics'
      : type.value === 'text/html' ? 'part.html'
        : type.value === 'text/plain' ? 'part.txt' : 'attachment';
  found.attachments.push({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: filename || fallbackName,
    contentType: type.value || 'application/octet-stream',
    contentBytes: content.toString('base64'),
    isInline: disposition.value !== 'attachment' && Boolean(contentId),
    ...(contentId ? { contentId } : {}),
  });
}

/**
 * Builds the create payload for one backed-up message.
 * Returns { payload } or { keepMime: reason } when the message must stay a MIME create.
 */
export function receivedMessageFromMime(bytes, { receivedDateTime = null, maxPayloadBytes = MAX_JSON_PAYLOAD_BYTES } = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const { head } = splitEntity(buf);
  const headers = parseHeaders(head);
  const topType = parseParams(header(headers, 'content-type') ?? 'text/plain').value;
  if (topType === 'multipart/signed' || topType === 'multipart/encrypted' || /^application\/(x-)?pkcs7-mime$/.test(topType)) {
    return { keepMime: 'signed or encrypted' };
  }
  const found = { text: null, html: null, attachments: [] };
  walk(buf, found);

  const sent = toIso(header(headers, 'date'));
  // The topmost Received header is the final delivery.
  const delivery = header(headers, 'received');
  const received = toIso(receivedDateTime) ?? toIso(delivery?.slice(delivery.lastIndexOf(';') + 1)) ?? sent;
  const priority = (header(headers, 'importance') ?? '').toLowerCase();
  const xPriority = Number.parseInt(header(headers, 'x-priority') ?? '', 10);
  const importance = priority === 'high' || xPriority === 1 || xPriority === 2 ? 'high'
    : priority === 'low' || xPriority === 4 || xPriority === 5 ? 'low' : 'normal';
  const messageId = header(headers, 'message-id');
  const from = parseAddresses(header(headers, 'from'))[0];
  const sender = parseAddresses(header(headers, 'sender'))[0];

  const properties = [{ id: PROP.flags, value: String(MSGFLAG_READ) }];
  if (received) properties.push({ id: PROP.delivered, value: received });
  if (sent ?? received) properties.push({ id: PROP.submitted, value: sent ?? received });
  if (messageId) properties.push({ id: PROP.messageId, value: messageId });
  properties.push({ id: PROP.headers, value: headerText(head).replace(/\r?\n/g, '\r\n') });

  const payload = {
    subject: decodeWords(header(headers, 'subject') ?? ''),
    body: found.html !== null
      ? { contentType: 'html', content: found.html }
      : { contentType: 'text', content: found.text ?? '' },
    ...(from ? { from } : {}),
    ...(sender ? { sender } : {}),
    toRecipients: parseAddresses(header(headers, 'to')),
    ccRecipients: parseAddresses(header(headers, 'cc')),
    bccRecipients: parseAddresses(header(headers, 'bcc')),
    replyTo: parseAddresses(header(headers, 'reply-to')),
    importance,
    ...(found.attachments.length ? { attachments: found.attachments } : {}),
    singleValueExtendedProperties: properties,
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > maxPayloadBytes) return { keepMime: 'too large to create as a received message' };
  return { payload };
}
