import type { NextConfig } from "next";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dirname, "..");

// No other site may frame the portal (clickjacking of approve or restore buttons).
const FRAME_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  agentRules: false,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: { authInterrupts: true },
  // The portal directly imports the sibling KEEL engine/status modules. Both
  // tracing and Turbopack resolution therefore need the shared repository root.
  outputFileTracingRoot: repositoryRoot,
  turbopack: { root: repositoryRoot },
  async headers() {
    return [{ source: "/:path*", headers: FRAME_HEADERS }];
  },
};

export default nextConfig;
