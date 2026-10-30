-- Restore approvals as a customer setting (engine/govern/restoreApprovalSettings.mjs).
--
-- One row per tenant and service (Entra, Intune, Exchange, Teams, SharePoint, Purview,
-- Power Platform, Defender). approval_required says whether a high-impact change a
-- restore makes in that service (shorter retention, a released hold, wider sharing, a
-- destroying action, a script run on devices, a shorter group lifetime) waits for a
-- second person to approve it. No row means on: every service needs the approval until
-- an admin turns it off. Each change is written to the audit record (evidence kind
-- 'restore-approval-setting').
CREATE TABLE IF NOT EXISTS restore_approval_setting (
  tenant_ref        text NOT NULL,
  service           text NOT NULL,
  approval_required boolean NOT NULL DEFAULT true,
  updated_by        text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_ref, service)
);
