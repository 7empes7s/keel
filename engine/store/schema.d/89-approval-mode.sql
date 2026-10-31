-- Approval mode (engine/govern/approvalMode.mjs).
--
-- approval_mode: whether the person who asked for a change may approve it themselves
-- ('solo', for a business with one admin) or a second person must ('two-person'). No
-- row means two-person, which is how Keel worked before the setting existed.
CREATE TABLE IF NOT EXISTS approval_mode (
  tenant_ref text PRIMARY KEY,
  mode       text NOT NULL CHECK (mode IN ('two-person', 'solo')),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A decision the requester made themselves, under solo mode. Kept on the decision so
-- the Approvals page and the audit record can say "Self-approved", and so the gates
-- that run the change later can stop counting it once the mode is two-person again.
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS self_approved boolean NOT NULL DEFAULT false;
ALTER TABLE content_effect_approval ADD COLUMN IF NOT EXISTS self_approved boolean NOT NULL DEFAULT false;
ALTER TABLE change_intent ADD COLUMN IF NOT EXISTS self_approved boolean NOT NULL DEFAULT false;

-- An emergency change's owner may be its approver only when it was self-approved (solo
-- mode). Replaces schema.sql's unnamed "owner <> approver" check with a named one.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'change_intent'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%owner_principal_id <> approver_principal_id%'
       AND conname <> 'change_intent_owner_approver_check'
  LOOP
    EXECUTE format('ALTER TABLE change_intent DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'change_intent'::regclass
                  AND conname = 'change_intent_owner_approver_check') THEN
    ALTER TABLE change_intent ADD CONSTRAINT change_intent_owner_approver_check
      CHECK (owner_principal_id <> approver_principal_id OR self_approved);
  END IF;
END $$;
