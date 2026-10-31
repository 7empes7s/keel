import assert from "node:assert/strict";
import { test } from "node:test";

import { evidenceMessage, optionalReasonMessage, reasonMessage, reasonProblem, refuseWeakReason, WeakReasonError } from "@/lib/written-reason";

// UI audit 31 Oct 2026, C1: "x", "BECAUSE" and "TEST-UX-001" were kept as reasons and evidence.

test("placeholders and one-word reasons are refused", () => {
  for (const text of ["x", "BECAUSE", "because", "TEST-UX-001", "test", "asdf", "ok ok", "n/a", "xxxxxxxxxxxx", "aaaa bbbb", "because because because", "123456789012", "test test test test", "...."]) {
    assert.notEqual(reasonProblem(text), null, `"${text}" should be refused`);
  }
  assert.equal(reasonProblem("BECAUSE"), "placeholder");
  assert.equal(reasonProblem("TEST-UX-001"), "placeholder");
  assert.equal(reasonProblem("x"), "too_short");
});

test("empty and blank reasons are refused", () => {
  for (const value of ["", "   ", "\n\t", null, undefined, 42]) assert.equal(reasonProblem(value), "empty");
  assert.match(reasonMessage("")!, /Write why/);
});

test("short real reasons are kept", () => {
  for (const text of [
    "Approved change CHG-5120",
    "quarterly test",
    "emergency over",
    "Planned rollout of new MFA policy",
    "Vendor asked for this setting",
    "Accepted: matches the new security baseline",
    "Fehlalarm, geplante Änderung",
    "計画された変更です",
    "सुरक्षा जांच पूरी हुई",
    "ซ่อมแซมระบบแล้ว",
    "تم التحقق من الإعدادات",
  ]) {
    assert.equal(reasonProblem(text), null, `"${text}" should be kept`);
  }
});

test("very long reasons are refused", () => {
  assert.equal(reasonProblem(`Planned change ${"a".repeat(1000)}`), "too_long");
});

test("optional fields may stay empty but not hold a placeholder", () => {
  assert.equal(optionalReasonMessage(""), null);
  assert.equal(optionalReasonMessage(undefined), null);
  assert.notEqual(optionalReasonMessage("x"), null);
  assert.equal(optionalReasonMessage("Quarterly test with the service desk"), null);
});

test("refuseWeakReason passes a good or missing reason through and throws on a weak one", () => {
  assert.equal(refuseWeakReason("  Planned change from the vendor  "), "  Planned change from the vendor  ");
  assert.equal(refuseWeakReason(""), "");
  assert.throws(() => refuseWeakReason("BECAUSE", "justification"), (error: unknown) => error instanceof WeakReasonError && error.field === "justification");
});

test("evidence must fit its type", () => {
  assert.notEqual(evidenceMessage("ticket", ""), null);
  assert.notEqual(evidenceMessage("ticket", "   "), null);
  assert.notEqual(evidenceMessage("ticket", "TEST-UX-001"), null);
  assert.notEqual(evidenceMessage("ticket", "x"), null);
  assert.notEqual(evidenceMessage("ticket", "done"), null);
  assert.equal(evidenceMessage("ticket", "CHG-5120"), null);
  assert.equal(evidenceMessage("ticket", "INC0012345"), null);
  assert.equal(evidenceMessage("ticket", "https://servicedesk.contoso.com/ticket/5120"), null);
  assert.notEqual(evidenceMessage("link", "ticket"), null);
  assert.notEqual(evidenceMessage("link", "https://x"), null);
  assert.equal(evidenceMessage("link", "https://contoso.sharepoint.com/sites/it/proof.docx"), null);
  assert.notEqual(evidenceMessage("log-reference", "log"), null);
  assert.equal(evidenceMessage("log-reference", "sentinel query 7f3a91"), null);
  assert.notEqual(evidenceMessage("attestation", "yes"), null);
  assert.equal(evidenceMessage("attestation", "I checked the mailbox with the user"), null);
  for (const ticket of ["OPS-42", "SEC-7", "12345", "#4471", "AB1-123", "Jira OPS-123", "ABC-123"]) assert.equal(evidenceMessage("ticket", ticket), null, ticket);
  for (const link of ["https://contoso.sharepoint.com/sites/IT/Restore%20test%20evidence.pdf", "https://github.com/contoso/runbooks/blob/main/temp/notes.md", "http://servicenow/change/123", "https://test-env.contoso.com/x"]) assert.equal(evidenceMessage("link", link), null, link);
  assert.notEqual(evidenceMessage("link", "https://example.com/proof"), null);
  assert.equal(evidenceMessage("log-reference", "Audit log entry for app consent"), null);
  assert.equal(evidenceMessage("log-reference", "SigninLogs | where CorrelationId == 'a1b2c3'"), null);
});
