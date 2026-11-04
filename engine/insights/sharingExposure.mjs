/**
 * Who can reach a site, compared between two backups (#968).
 *
 * The content backup saves a plain summary beside each site's `site/permissions` item
 * (engine/content/sharepointSites.mjs permissionsSummary) and each OneDrive file's exposure
 * beside its record (engine/content/permissionExposure.mjs). This compares two of them and
 * lists what opened up or closed:
 *
 *  - an Everyone or everyone-except-external grant added or removed, with its level;
 *  - anyone links added (the count went up);
 *  - new guests;
 *  - the last owner removed.
 *
 * A summary saved before the exposure counts existed (summary v1, or a OneDrive record
 * without `exposure`) compares as unknown, never as zero: it produces no change, so an
 * upgrade never reads as "removed". Pure.
 */

export const EXPOSURE_SUMMARY_VERSION = 2;
/** The change feed kinds of these rows: a site's access, and a OneDrive's. */
export const SITE_ACCESS_KIND = 'sharepoint-site-access';
export const ONEDRIVE_ACCESS_KIND = 'onedrive-access';
export const EXPOSURE_KINDS = Object.freeze([SITE_ACCESS_KIND, ONEDRIVE_ACCESS_KIND]);
export const AUDIENCES = Object.freeze(['everyone', 'everyone-except-external']);
// Narrowest first.
export const LEVELS = Object.freeze(['view', 'edit', 'full control']);

/** The highest level a list of SharePoint or Graph role names gives. */
export function levelOf(roles) {
  let best = 0;
  for (const role of Array.isArray(roles) ? roles : []) {
    const name = String(role ?? '').toLowerCase();
    if (/^(full control|owner|sp\.full control)$/.test(name)) best = Math.max(best, 2);
    else if (/^(edit|contribute|design|write)$/.test(name)) best = Math.max(best, 1);
  }
  return LEVELS[best];
}
export const canEdit = (level) => LEVELS.indexOf(level) >= LEVELS.indexOf('edit');

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const anyoneLinks = (links) => {
  const anyone = links?.anyone;
  if (!anyone || typeof anyone !== 'object') return null;
  const total = ['view', 'edit', 'unknown'].reduce((sum, access) => sum + (Number.isInteger(anyone[access]) ? anyone[access] : 0), 0);
  return total;
};

/** The Everyone grants in a list of { audience, roles }, as audience -> highest level. */
function everyoneLevels(grants) {
  if (!Array.isArray(grants)) return null;
  const levels = new Map();
  for (const grant of grants) {
    if (!AUDIENCES.includes(grant?.audience)) continue;
    const level = levelOf(grant.roles);
    const had = levels.get(grant.audience);
    if (!had || LEVELS.indexOf(level) > LEVELS.indexOf(had)) levels.set(grant.audience, level);
  }
  return levels;
}

/**
 * What one saved site summary says about exposure, each part null when the backup did not
 * read it: { everyone: Map | null, anyoneLinks, guests, owners }.
 */
export function siteExposure(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const exposure = Number(summary.v) >= EXPOSURE_SUMMARY_VERSION && summary.exposure && typeof summary.exposure === 'object' ? summary.exposure : null;
  return {
    // A site that inherits its roles saves `everyone: null`: not read, not none.
    everyone: exposure ? everyoneLevels(exposure.everyone) : null,
    anyoneLinks: exposure ? anyoneLinks(exposure.links) : null,
    guests: count(summary.guests),
    owners: count(summary.ownerCount),
  };
}

function everyoneChanges(before, after) {
  if (!before || !after) return [];
  const changes = [];
  for (const audience of AUDIENCES) {
    const was = before.get(audience) ?? null;
    const now = after.get(audience) ?? null;
    if (now && (!was || LEVELS.indexOf(now) > LEVELS.indexOf(was))) changes.push({ what: 'everyone', change: 'added', audience, level: now, before: was });
    else if (was && (!now || LEVELS.indexOf(now) < LEVELS.indexOf(was))) changes.push({ what: 'everyone', change: 'removed', audience, level: was, after: now });
  }
  return changes;
}

/**
 * What opened up or closed between two saved site summaries, in a fixed order:
 * [{ what: 'everyone', change, audience, level } | { what: 'anyone-links', change: 'added', count, total }
 *  | { what: 'guests', change: 'added', count, total } | { what: 'owners', change: 'removed', count }].
 * Empty when either side is missing.
 */
export function compareSiteExposure(beforeSummary, afterSummary) {
  const before = siteExposure(beforeSummary);
  const after = siteExposure(afterSummary);
  if (!before || !after) return [];
  const changes = everyoneChanges(before.everyone, after.everyone);
  if (before.anyoneLinks !== null && after.anyoneLinks !== null && after.anyoneLinks > before.anyoneLinks) {
    changes.push({ what: 'anyone-links', change: 'added', count: after.anyoneLinks - before.anyoneLinks, total: after.anyoneLinks });
  }
  if (before.guests !== null && after.guests !== null && after.guests > before.guests) {
    changes.push({ what: 'guests', change: 'added', count: after.guests - before.guests, total: after.guests });
  }
  if (before.owners !== null && after.owners !== null && before.owners > 0 && after.owners === 0) {
    changes.push({ what: 'owners', change: 'removed', count: before.owners });
  }
  return changes;
}

const anyoneLinkIds = (exposure) => (Array.isArray(exposure?.linkGrants)
  ? exposure.linkGrants.filter((link) => link?.scope === 'anonymous' && link.id).map((link) => String(link.id))
  : null);

/**
 * What opened up on one OneDrive between two backups, from its files' records that
 * changed: each entry { before, after } holds a file's saved exposure in the backup before
 * and in this one. Only additions: a grant or link gone from one file can still reach the
 * drive through another. A file whose earlier record has no exposure is skipped.
 */
export function compareDriveExposure(files) {
  const added = new Map();
  const links = new Set();
  for (const { before, after } of Array.isArray(files) ? files : []) {
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object') continue;
    for (const change of everyoneChanges(everyoneLevels(before.everyone), everyoneLevels(after.everyone))) {
      if (change.change !== 'added') continue;
      const had = added.get(change.audience);
      if (!had || LEVELS.indexOf(change.level) > LEVELS.indexOf(had.level)) added.set(change.audience, change);
    }
    const was = anyoneLinkIds(before);
    const now = anyoneLinkIds(after);
    if (was && now) for (const id of now) if (!was.includes(id)) links.add(id);
  }
  const changes = AUDIENCES.filter((audience) => added.has(audience)).map((audience) => added.get(audience));
  if (links.size) changes.push({ what: 'anyone-links', change: 'added', count: links.size, total: null });
  return changes;
}

const AUDIENCE_WORDS = Object.freeze({ everyone: 'Everyone, guests included', 'everyone-except-external': 'Everyone in the company' });
const LEVEL_WORDS = Object.freeze({ view: 'view', edit: 'edit', 'full control': 'fully control' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The change in words, for the feed row's activity. */
export function exposureActivity(change) {
  switch (change.what) {
    case 'everyone':
      return change.change === 'added'
        ? `${AUDIENCE_WORDS[change.audience]} can now ${LEVEL_WORDS[change.level]}.`
        : `${AUDIENCE_WORDS[change.audience]} can no longer ${LEVEL_WORDS[change.level]}${change.after ? ` (can still ${LEVEL_WORDS[change.after]})` : ''}.`;
    case 'anyone-links':
      return change.total === null || change.total === undefined
        ? `${plural(change.count, 'new link', 'new links')} anyone can open.`
        : `${plural(change.count, 'new link', 'new links')} anyone can open (${change.total} in all).`;
    case 'guests':
      return `${plural(change.count, 'new guest', 'new guests')} (${change.total} in all).`;
    case 'owners':
      return 'No owner left: the last owner was removed.';
    default:
      return null;
  }
}
