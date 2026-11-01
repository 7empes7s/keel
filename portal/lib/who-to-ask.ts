// Who to ask (UI audit D12). A page that cannot do something for the reader names the
// people who can, instead of "ask your server admin". Names come from the People list
// (`getContacts`); null means they could not be read, and the sentence falls back to the
// role's name so the page still says which role to look for.

export interface Contacts {
  // Everyone else who holds the role; the reader is never in these lists.
  admins: string[];
  investigators: string[];
  // The reader is a Keel admin, so server work is theirs to do or share.
  youAreAdmin?: boolean;
}

/** "Ana", "Ana or Ben", "Ana, Ben or Cy", "Ana, Ben, Cy or 2 others". */
export function orList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  const rest = names.length - 3;
  return `${names.slice(0, 3).join(", ")} or ${rest} other${rest === 1 ? "" : "s"}`;
}

/** The person or people to ask, with their role: "Ana (Keel admin)", "Ana or Ben (Keel admins)". */
export function askWho(names: string[] | null | undefined, role: { one: string; many: string }): string {
  if (!names?.length) return `a ${role.one}`;
  return `${orList(names)} (${names.length === 1 ? role.one : role.many})`;
}

export const ADMIN_ROLE = { one: "Keel admin", many: "Keel admins" };
export const INVESTIGATOR_ROLE = { one: "investigator", many: "investigators" };

// Work done on the machine Keel runs on, not in the portal (its off-site copy, drills,
// where backups are stored). Keel admins set Keel up, so they are the people to ask.
/** "Ask Ana (Keel admin) to fix the daily off-site copy on the Keel server." */
export function askServerAdmin(contacts: Contacts | null | undefined, task: string): string {
  if (contacts?.youAreAdmin) {
    return contacts.admins.length
      ? `As a Keel admin, ${task} yourself or ask ${askWho(contacts.admins, ADMIN_ROLE)}.`
      : `As the Keel admin, ${task}.`;
  }
  return `Ask ${askWho(contacts?.admins, ADMIN_ROLE)} to ${task}.`;
}

/** What a reader without the investigator role can do on Incidents. Names the
 * investigators; with none, names the admins who can give the role. */
export function investigatorLine(contacts: Contacts | null | undefined, canGrant: boolean): string {
  const investigators = contacts?.investigators ?? null;
  if (investigators?.length) return `Only investigators can open or change incidents. Ask ${askWho(investigators, INVESTIGATOR_ROLE)}.`;
  if (canGrant && investigators) return "Only investigators can open or change incidents, and nobody has the role yet. You can give it to yourself or someone else.";
  if (investigators) return `Only investigators can open or change incidents, and nobody has the role yet. Ask ${askWho(contacts?.admins, ADMIN_ROLE)} to give it to someone.`;
  return `Only investigators can open or change incidents. Ask ${askWho(contacts?.admins, ADMIN_ROLE)} who has the role, or for the role.`;
}
