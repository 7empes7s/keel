/**
 * Time in words, shared by the portal (lib/presentation.ts) and the weekly summary
 * (summary.mjs). No imports, so any client page can use it cheaply.
 */

/**
 * "2 hours ago", "3 days ago": how long ago, in words.
 * @param {string | null} value
 * @param {string | Date} now
 * @returns {string}
 */
export function ago(value, now) {
  if (!value) return 'at an unknown time';
  const milliseconds = new Date(now).valueOf() - new Date(value).valueOf();
  if (!Number.isFinite(milliseconds)) return 'at an unknown time';
  if (milliseconds < 0) return 'in the future';
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
