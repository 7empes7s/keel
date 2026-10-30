-- Restore approvals for kinds of restore, next to the per-service setting
-- (restore_approval_setting, engine/govern/restoreApprovalSettings.mjs).
--
-- One row per tenant and kind of restore: content restores (mail, files, Teams),
-- turning a Conditional Access policy on, compliance fixes, tenant-wide changes,
-- restores into another tenant, and objects Keel cannot place in a service.
-- approval_required says whether a restore of that kind waits for a person. No row
-- means on, until an admin turns it off. Each change is written to the audit record
-- (evidence kind 'restore-approval-setting', subject.rule).
CREATE TABLE IF NOT EXISTS restore_approval_rule (
  tenant_ref        text NOT NULL,
  rule              text NOT NULL,
  approval_required boolean NOT NULL DEFAULT true,
  updated_by        text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_ref, rule)
);
