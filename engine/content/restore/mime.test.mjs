import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { decodeWords, parseAddresses, receivedMessageFromMime } from './mime.mjs';

const prop = (payload, id) => payload.singleValueExtendedProperties.find((property) => property.id === id)?.value;

const MULTIPART = [
  'Received: from mx.contoso.test by mbx.contoso.test; Wed, 15 Oct 2026 07:48:01 +0000',
  'Received: from sender.test by mx.contoso.test; Wed, 15 Oct 2026 07:48:00 +0000',
  'Message-ID: <KEEL-RT-multi@contoso.test>',
  'From: =?UTF-8?B?S0VFTC1SVCDDiXF1aXBl?= <team@contoso.test>',
  'To: "Doe, Jane" <jane@contoso.test>, bob@contoso.test (Bob B),',
  ' Team: carl@contoso.test, dina@contoso.test;',
  'Cc: <eve@contoso.test>',
  'Subject: =?ISO-8859-1?Q?KEEL-RT_caf=E9?= =?UTF-8?Q?_r=C3=A9sum=C3=A9?=',
  'Date: Wed, 15 Oct 2026 09:47:59 +0200 (CEST)',
  'Importance: high',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  'preamble',
  '--outer',
  'Content-Type: multipart/alternative; boundary=inner',
  '',
  '--inner',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Caf=C3=A9 plain',
  '--inner',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<p>Caf=C3=A9 <img src=3D"cid:logo@x"></p>=',
  '',
  '--inner--',
  '--outer',
  'Content-Type: image/png',
  'Content-ID: <logo@x>',
  'Content-Transfer-Encoding: base64',
  '',
  'iVBORw0K',
  'GgoA',
  '--outer',
  'Content-Type: application/pdf; name="ignored.pdf"',
  "Content-Disposition: attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf",
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4').toString('base64'),
  '--outer--',
  '',
].join('\r\n');

test('a multipart message becomes a received message with its body, addresses, attachments and times', () => {
  const { payload, keepMime } = receivedMessageFromMime(Buffer.from(MULTIPART));
  assert.equal(keepMime, undefined);
  assert.equal(payload.subject, 'KEEL-RT café résumé');
  assert.deepEqual(payload.from, { emailAddress: { name: 'KEEL-RT Équipe', address: 'team@contoso.test' } });
  assert.deepEqual(payload.toRecipients.map((r) => r.emailAddress), [
    { name: 'Doe, Jane', address: 'jane@contoso.test' }, { name: 'Bob B', address: 'bob@contoso.test' },
    { address: 'carl@contoso.test' }, { address: 'dina@contoso.test' },
  ]);
  assert.deepEqual(payload.ccRecipients, [{ emailAddress: { address: 'eve@contoso.test' } }]);
  assert.deepEqual(payload.body, { contentType: 'html', content: '<p>Café <img src="cid:logo@x"></p>' });
  assert.equal(payload.importance, 'high');
  assert.deepEqual(payload.attachments.map(({ name, contentType, isInline, contentId }) => ({ name, contentType, isInline, contentId })), [
    { name: 'attachment', contentType: 'image/png', isInline: true, contentId: 'logo@x' },
    { name: 'résumé.pdf', contentType: 'application/pdf', isInline: false, contentId: undefined },
  ]);
  assert.equal(Buffer.from(payload.attachments[1].contentBytes, 'base64').toString(), '%PDF-1.4');
  assert.equal(prop(payload, 'Integer 0x0E07'), '1', 'read and not unsent, so not a draft');
  assert.equal(prop(payload, 'SystemTime 0x0E06'), '2026-10-15T07:48:01.000Z', 'received: the final Received header');
  assert.equal(prop(payload, 'SystemTime 0x0039'), '2026-10-15T07:47:59.000Z', 'sent: the Date header');
  assert.equal(prop(payload, 'String 0x1035'), '<KEEL-RT-multi@contoso.test>');
  assert.match(prop(payload, 'String 0x007D'), /^Received: from mx\.contoso\.test.*\r\n.*Content-Type: multipart\/mixed; boundary="outer"$/s);
});

test('the backed-up received time wins over the headers', () => {
  const { payload } = receivedMessageFromMime(Buffer.from(MULTIPART), { receivedDateTime: '2026-10-15T07:48:05Z' });
  assert.equal(prop(payload, 'SystemTime 0x0E06'), '2026-10-15T07:48:05.000Z');
});

test('a plain text message with bare LF line ends', () => {
  const { payload } = receivedMessageFromMime(Buffer.from('Subject: KEEL-RT-lf\nFrom: a@contoso.test\nDate: Wed, 15 Oct 2026 07:00:00 +0000\n\nline one\nline two\n'));
  assert.equal(payload.subject, 'KEEL-RT-lf');
  assert.deepEqual(payload.body, { contentType: 'text', content: 'line one\nline two\n' });
  assert.equal(prop(payload, 'SystemTime 0x0E06'), '2026-10-15T07:00:00.000Z', 'with no Received header, the Date header');
  assert.equal(payload.attachments, undefined);
});

test('signed, encrypted and oversized messages stay a MIME create', () => {
  assert.deepEqual(receivedMessageFromMime(Buffer.from('Content-Type: multipart/signed; boundary=b\r\n\r\n--b--\r\n')), { keepMime: 'signed or encrypted' });
  assert.deepEqual(receivedMessageFromMime(Buffer.from('Content-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n\r\nAAAA\r\n')), { keepMime: 'signed or encrypted' });
  assert.deepEqual(receivedMessageFromMime(Buffer.from(MULTIPART), { maxPayloadBytes: 1000 }), { keepMime: 'too large to create as a received message' });
});

test('encoded words and address edge cases', () => {
  assert.equal(decodeWords('=?utf-8?q?a_b?= =?utf-8?q?_c?= plain'), 'a b c plain');
  assert.equal(decodeWords('=?windows-1252?Q?=80uro?='), '€uro');
  assert.deepEqual(parseAddresses('undisclosed-recipients:;'), []);
  assert.deepEqual(parseAddresses('"Quote \\"Q\\"" <q@contoso.test>'), [{ emailAddress: { name: 'Quote "Q"', address: 'q@contoso.test' } }]);
});
