// Teams workload reads.
export default Object.freeze({
  service: 'Teams',
  prefix: /^teams/,
  fallback: 'tenant',
  // Types by kind, in the order a list shows them: people and objects first, then
  // roles and access, then policies, then tenant-wide settings. taxonomy.test.mjs fails
  // on an entry that is in no group, so a new type has to be placed here. Every group
  // the service has is listed, even with no type yet: `match` places a kind Keel has
  // not mapped yet (see placeUnmapped in ../taxonomy.mjs).
  categories: Object.freeze([
    { key: 'teams', name: 'Teams and members', types: ['teams-settings'], match: /^teams(settings|team|channel|member|owner|template)/ },
    { key: 'apps', name: 'Custom apps', types: ['teamsCatalogApp'], match: /catalogapp|customapp/ },
    { key: 'roles', name: 'Admin roles', types: [], match: /role/ },
    { key: 'org', name: 'Organization policies', types: ['teams-org-policies'], match: /orgpolic|external|guest|federation|apppermission|appsetup|messaging|chat|update|channelpolic/ },
    { key: 'calling', name: 'Calling and meetings', types: ['teams-voice-policies'], match: /voice|calling|call|meeting|liveevent|events|webinar|townhall|emergency|dialplan|phone/ },
    { key: 'tenant', name: 'Tenant settings', types: [], match: /setting|config|tenant/ },
  ]),
  entries: Object.freeze({
    // Remaining kinds, batch 9: a catalogue type; priority comes from the catalogue.
    teamsCatalogApp: { name: 'Teams custom app' },
    'teams-settings': {
      name: 'Team setting or membership',
      priority: 'normal',
      reason: 'Changes who is in a team and what its members can do.',
    },
    'teams-org-policies': {
      name: 'Teams organization policy',
      priority: 'high',
      reason: 'Controls external and guest access in Teams for the whole organization.',
    },
    'teams-voice-policies': {
      name: 'Teams calling, voice or live event policy',
      priority: 'normal',
      reason: 'Changes calling and meeting features for the users it applies to.',
    },
  }),
});
