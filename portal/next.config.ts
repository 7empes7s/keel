import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Keep file tracing rooted in this app even when another lockfile exists on the VPS.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
