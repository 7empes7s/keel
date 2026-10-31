-- Since 2026-10-31 whoever acknowledges an alert owns it (owner_source 'acknowledged',
-- engine/notify/alerts.mjs acknowledgeAlert). Alerts acknowledged before that kept no
-- owner. Give each one still acknowledged and still without an owner its acknowledger,
-- when that is a known person. Re-applying changes nothing.
UPDATE alert a
   SET owner_principal_id = a.acknowledged_by::uuid, owner_source = 'acknowledged', updated_at = now()
 WHERE a.state = 'acknowledged' AND a.owner_principal_id IS NULL
   AND a.acknowledged_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND EXISTS (SELECT 1 FROM principal p WHERE p.id::text = lower(a.acknowledged_by));
