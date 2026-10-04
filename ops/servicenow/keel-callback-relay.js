/*
 * Roadmap task-118: the instance-side half of the signed ServiceNow callback, for the
 * NON-PRODUCTION qualification instance. It is installed by the operator, by hand, as a
 * business rule; KEEL never installs or changes anything in an instance.
 *
 *   Table:     the table mapped in the KEEL adapter config (config.table)
 *   When:      after, update
 *   Condition: the mapped approval state field changes (for example current.u_gate.changes())
 *
 * It signs the decision exactly as engine/itsm/adapters/servicenow.mjs verifies it:
 *   header value  t=<unix seconds>,v1=<base64 HMAC-SHA256 of "<t>.<body>">
 *   body          {"sys_id":..., "sys_mod_count":..., "record":{<state>, <approver>, <plan version>, <plan digest>}}
 * and writes both into the relay table u_keel_callback_relay (string fields u_record,
 * u_signature, u_body), which the capture tool (tools/qualification/servicenowLive.mjs)
 * reads with KEEL's own credential. No outbound REST message is needed, so the
 * qualification needs no public KEEL ingress.
 *
 * The signing key is read from the system property x_keel.callback_signing_key_b64
 * (type password2), holding the BASE64 of the value KEEL resolves from the adapter's
 * callback.secretRef. GlideCertificateEncryption.generateMac takes a base64 key; this was
 * read from the search index of the official docs and is unproven until the capture runs.
 *
 * Set FIELDS to the same field names as the KEEL adapter config's fields.
 */
(function executeRule(current, previous) {
  var FIELDS = {
    state: 'u_gate',                 // config.fields.state
    approver: 'u_gate_owner.email',  // config.fields.approver (may be dot-walked)
    planVersion: 'u_plan_rev',       // config.fields.planVersion
    planDigest: 'u_plan_hash'        // config.fields.planDigest
  };
  var RELAY_TABLE = 'u_keel_callback_relay';
  var KEY_PROPERTY = 'x_keel.callback_signing_key_b64';

  function value(field) {
    var element = current.getElement(field);
    return element === null || element === undefined ? '' : String(element.toString());
  }

  var key = gs.getProperty(KEY_PROPERTY, '');
  if (!key) {
    gs.error('KEEL callback relay: ' + KEY_PROPERTY + ' is not set; no callback written');
    return;
  }
  var record = {};
  record[FIELDS.state] = value(FIELDS.state);
  record[FIELDS.approver] = value(FIELDS.approver);
  record[FIELDS.planVersion] = value(FIELDS.planVersion);
  record[FIELDS.planDigest] = value(FIELDS.planDigest);
  var body = JSON.stringify({
    sys_id: current.getUniqueValue(),
    sys_mod_count: String(current.getValue('sys_mod_count')),
    record: record
  });
  var t = String(Math.floor(new GlideDateTime().getNumericValue() / 1000));
  var mac = new GlideCertificateEncryption().generateMac(key, 'HmacSHA256', t + '.' + body);

  var relay = new GlideRecord(RELAY_TABLE);
  relay.initialize();
  relay.setValue('u_record', current.getUniqueValue());
  relay.setValue('u_signature', 't=' + t + ',v1=' + mac);
  relay.setValue('u_body', body);
  relay.insert();
})(current, previous);
