import type { NextConfig } from "next";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dirname, "..");

const nextConfig: NextConfig = {
  agentRules: false,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: { authInterrupts: true },
  // The portal directly imports the sibling KEEL engine/status modules. Both
  // tracing and Turbopack resolution therefore need the shared repository root.
  outputFileTracingRoot: repositoryRoot,
  turbopack: { root: repositoryRoot },
};

export default nextConfig;
