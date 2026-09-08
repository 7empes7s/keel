import { headers } from "next/headers";

import { AUTHENTICATED_EMAIL_HEADER } from "@/lib/cloudflare-access";

export default async function Home() {
  const email = (await headers()).get(AUTHENTICATED_EMAIL_HEADER);

  if (!email) {
    throw new Error("Verified Cloudflare Access identity is missing");
  }

  return (
    <main>
      <p className="eyebrow">Operator portal</p>
      <h1>KEEL</h1>
      <p className="identity">{email}</p>
    </main>
  );
}

