import { capabilitiesForPrincipal } from './principals.mjs';

export async function schedulerPrincipal(client) {
  const { rows: [principal] } = await client.query(
    `INSERT INTO principal (email, display_name, system_kind)
     VALUES ('scheduler@keel.internal', 'KEEL scheduler', 'scheduler')
     ON CONFLICT (lower(email)) DO UPDATE SET email = principal.email RETURNING *`,
  );
  const capabilities = await capabilitiesForPrincipal(client, principal);
  if (principal.system_kind !== 'scheduler' || capabilities.length !== 2
      || !capabilities.includes('collect') || !capabilities.includes('configuration')) {
    throw new Error('scheduler principal must hold exactly collect + configuration');
  }
  return principal;
}

