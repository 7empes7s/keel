-- Security audit finding 6: ServiceNow and the Teams, Slack, PagerDuty and SMS channels
-- now only read credential references named env:KEEL_INTEGRATION_*, as SIEM webhooks
-- already do, so a setting can never pick up the database URL or another worker secret.
-- Settings saved before that may hold another env: name. They are carried over to the
-- integration name, upper-cased: env:KEEL_SLACK_WEBHOOK becomes
-- env:KEEL_INTEGRATION_KEEL_SLACK_WEBHOOK (and env:keel_integration_x becomes
-- env:KEEL_INTEGRATION_X). Whoever runs the server then adds that
-- variable with the old value; until then the channel reports the missing setting.
-- References already in the namespace are left alone, so this is safe to re-apply.
-- (Live, 2026-10-28, operator queue Q199: no ServiceNow or channel rows, nothing to carry.)
CREATE OR REPLACE FUNCTION keel_integration_reference(ref text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN ref IS NULL OR ref !~ '^env:[A-Za-z_][A-Za-z0-9_]*$' THEN ref
    WHEN ref ~ '^env:KEEL_INTEGRATION_[A-Z0-9_]+$' THEN ref
    ELSE 'env:KEEL_INTEGRATION_' || regexp_replace(upper(substr(ref, 5)), '^KEEL_INTEGRATION_', '')
  END
$$;

UPDATE itsm_adapter_config
   SET config = jsonb_set(config, '{credential,tokenRef}',
                          to_jsonb(keel_integration_reference(config->'credential'->>'tokenRef')))
 WHERE adapter = 'servicenow'
   AND jsonb_typeof(config->'credential'->'tokenRef') = 'string'
   AND keel_integration_reference(config->'credential'->>'tokenRef') <> config->'credential'->>'tokenRef';

UPDATE itsm_adapter_config
   SET config = jsonb_set(config, '{callback,secretRef}',
                          to_jsonb(keel_integration_reference(config->'callback'->>'secretRef')))
 WHERE adapter = 'servicenow'
   AND jsonb_typeof(config->'callback'->'secretRef') = 'string'
   AND keel_integration_reference(config->'callback'->>'secretRef') <> config->'callback'->>'secretRef';

UPDATE channel
   SET config = jsonb_set(config, '{endpointRef}', to_jsonb(keel_integration_reference(config->>'endpointRef')))
 WHERE kind IN ('teams', 'slack')
   AND jsonb_typeof(config->'endpointRef') = 'string'
   AND keel_integration_reference(config->>'endpointRef') <> config->>'endpointRef';

UPDATE channel
   SET config = jsonb_set(config, '{routingKeyRef}', to_jsonb(keel_integration_reference(config->>'routingKeyRef')))
 WHERE kind = 'pagerduty'
   AND jsonb_typeof(config->'routingKeyRef') = 'string'
   AND keel_integration_reference(config->>'routingKeyRef') <> config->>'routingKeyRef';

UPDATE channel
   SET config = jsonb_set(config, '{authTokenRef}', to_jsonb(keel_integration_reference(config->>'authTokenRef')))
 WHERE kind = 'sms'
   AND jsonb_typeof(config->'authTokenRef') = 'string'
   AND keel_integration_reference(config->>'authTokenRef') <> config->>'authTokenRef';
