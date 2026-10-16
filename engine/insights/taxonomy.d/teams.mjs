// Teams workload reads.
export default Object.freeze({
  service: 'Teams',
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
