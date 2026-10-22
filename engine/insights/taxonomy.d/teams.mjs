// Teams workload reads.
export default Object.freeze({
  service: 'Teams',
  // Types by kind, in the order a list shows them: people and objects first, then
  // roles and access, then policies, then tenant-wide settings. taxonomy.test.mjs fails
  // on an entry that is in no group, so a new type has to be placed here.
  categories: Object.freeze([
    { key: 'teams', name: 'Teams and members', types: ['teams-settings'] },
    { key: 'org', name: 'Organization policies', types: ['teams-org-policies'] },
    { key: 'calling', name: 'Calling and meetings', types: ['teams-voice-policies'] },
  ]),
  entries: Object.freeze({
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
