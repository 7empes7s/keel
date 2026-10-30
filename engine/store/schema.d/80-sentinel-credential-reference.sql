-- Security audit finding 6, part 3: the Sentinel (azure-monitor-sentinel) SIEM destination
-- now only reads a sender credential reference named env:KEEL_INTEGRATION_*, as webhooks,
-- ServiceNow and the alert channels do, so a destination can never pick up the database
-- URL or another worker secret. Destinations saved before that may hold another env: name.
-- They are carried over to the integration name, upper-cased: env:KEEL_SENTINEL_CRED
-- becomes env:KEEL_INTEGRATION_KEEL_SENTINEL_CRED (and env:keel_integration_x becomes
-- env:KEEL_INTEGRATION_X). Whoever runs the server then adds that variable with the old
-- value; until then the destination reports the missing setting and its events stay
-- pending. References already in the namespace are left alone, so this is safe to re-apply.
UPDATE siem_destination
   SET config = jsonb_set(config, '{credentialRef}', to_jsonb(
         'env:KEEL_INTEGRATION_' || regexp_replace(upper(substr(config->>'credentialRef', 5)), '^KEEL_INTEGRATION_', '')))
 WHERE kind = 'azure-monitor-sentinel'
   AND jsonb_typeof(config->'credentialRef') = 'string'
   AND config->>'credentialRef' ~ '^env:[A-Za-z_][A-Za-z0-9_]*$'
   AND config->>'credentialRef' !~ '^env:KEEL_INTEGRATION_[A-Z0-9_]+$';
