// Names, not ids. One check for text that is, or holds, a Microsoft object id, so no
// page shows one. Graph ids come in more shapes than a GUID:
// - a GUID: 1fec8e78-bce4-4aaf-ab1b-5451cc387264 (most objects, app ids)
// - a long hex run: the two halves of a provisioning job id (AD2AADProvisioning.<32 hex>.<32 hex>)
// - an opaque token: an app consent grant id is 43 base64url characters
//   (l5eW7x0ga0-WDOntXzHateQDNpSH5-lPk9HjD3Sarjk)
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HEX_RUN = /(?<![0-9A-Za-z])[0-9a-f]{32,}(?![0-9A-Za-z])/i;
const TOKEN = /[A-Za-z0-9_-]{20,}/g;

// A run of 20 or more letters, digits, "-" and "_" with no space that mixes upper case,
// lower case and digits reads as an opaque id when it is very long, or when digits
// break it up three or more times. Names such as "WindowsDefenderATP2024" or
// "contoso-human-resources-app" stay names.
function opaqueToken(token: string): boolean {
  if (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/[0-9]/.test(token)) return false;
  if (token.length >= 40) return true;
  return (token.match(/[0-9]+/g) ?? []).length >= 3;
}

export function holdsObjectId(text: string): boolean {
  if (GUID.test(text) || HEX_RUN.test(text)) return true;
  return (text.match(TOKEN) ?? []).some(opaqueToken);
}
