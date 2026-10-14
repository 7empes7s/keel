// The portal has no session of its own: Cloudflare Access signs operators in, through
// Microsoft. Signing out therefore ends those two sessions, never a portal one.

// Cloudflare Access serves this path on the portal's own domain. It clears the portal's
// Access cookie and revokes the operator's Access session for every application.
export const ACCESS_SIGN_OUT_PATH = "/cdn-cgi/access/logout";

// Ends the Microsoft sign-in in this browser. Without it, the next Access sign-in is
// completed silently with the same Microsoft account, so no other account can be picked.
export const MICROSOFT_SIGN_OUT_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/logout";
