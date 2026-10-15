-- Wave 2 RBAC: approval policies (engine/govern/approvalPolicy.mjs).
--
-- approval_policy: the two-person rule per tenant and kind of action. No row means off,
-- which is every action until someone turns it on.
CREATE TABLE IF NOT EXISTS approval_policy (
  tenant_ref   text NOT NULL,
  action_class text NOT NULL CHECK (action_class IN (
                 'content-restore-other-location', 'bulk-restore', 'delete',
                 'retention-shortening', 'legal-hold-release')),
  two_person   boolean NOT NULL DEFAULT false,
  updated_by   text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_ref, action_class)
);

-- What a request was when it was made: its policy actions, how many distinct approvers
-- it needed then (a later policy change can raise that, never lower it), and the
-- standing policy it was approved under, if any. NULL is a request made before Wave 2.
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS policy_actions jsonb;
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS required_approvals int;
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS standing_policy text;

-- One row per approver who signed a request that needs two. The primary key stops the
-- same person signing twice.
CREATE TABLE IF NOT EXISTS approval_signoff (
  request_id      uuid NOT NULL REFERENCES approval_request(id) ON DELETE CASCADE,
  approver        text NOT NULL,
  standing_policy text,
  signed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, approver)
);
