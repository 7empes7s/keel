/**
 * The template family a stored row files by (taxonomy settingKind), worked out when the
 * row is read.
 *
 * A settings catalog policy (configurationPolicy) carries its family itself, in
 * templateReference.templateFamily. An older endpoint security policy
 * (deviceManagementIntent) carries only the id of the template it was made from; its
 * area is that template's templateSubtype (firewall, antivirus…). Templates are read on
 * their own schedule, so the subtype is looked up in the newest stored copy of the
 * template, in any backup of the same tenant, and never written onto the policy: a
 * backup that did not read the templates changes nothing about the policy.
 *
 * Template ids are the same in every tenant and a template's subtype never changes, so
 * any stored copy answers.
 */

export const INTENT_TYPE = 'deviceManagementIntent';
export const TEMPLATE_TYPE = 'deviceManagementTemplate';

/**
 * SQL for the subtype of the template an older endpoint security policy was made from,
 * or NULL when no backup of the tenant holds that template.
 * @param {string} templateIdExpr SQL text giving the template id
 * @param {string} tenantExpr SQL text giving the tenant_ref
 */
export function templateAreaSql(templateIdExpr, tenantExpr) {
  // resource_version_key_idx (natural_key, snapshot_id) finds the template's copies.
  return `(SELECT tpl.payload->>'templateSubtype'
     FROM resource_version tpl JOIN snapshot tpls ON tpls.id = tpl.snapshot_id
    WHERE tpl.natural_key = '${TEMPLATE_TYPE}:' || (${templateIdExpr}) AND tpls.tenant_ref = ${tenantExpr}
    ORDER BY tpls.started_at DESC, tpls.id DESC LIMIT 1)`;
}

/**
 * SQL for the template family of a stored row: the template's subtype for an older
 * endpoint security policy, else templateReference.templateFamily of the first payload
 * that has one.
 * @param {{ typeExpr: string, payloads: string[], tenantExpr: string }} args
 */
export function templateFamilySql({ typeExpr, payloads, tenantExpr }) {
  const family = payloads.map((payload) => `${payload}->'templateReference'->>'templateFamily'`).join(', ');
  const templateId = payloads.map((payload) => `${payload}->>'templateId'`).join(', ');
  return `(CASE WHEN ${typeExpr} = '${INTENT_TYPE}' THEN ${templateAreaSql(`COALESCE(${templateId})`, tenantExpr)}
     ELSE COALESCE(${family}) END)`;
}

/** templateFamilySql for a drift row aliased `d`, from either copy it holds. */
export const DRIFT_TEMPLATE_FAMILY_SQL = templateFamilySql({ typeExpr: 'd.resource_type', payloads: ['d.after_payload', 'd.before_payload'], tenantExpr: 'd.tenant_ref' });
