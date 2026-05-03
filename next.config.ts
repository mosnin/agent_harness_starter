import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@openai/agents",
    "composio-core",
    "@daytonaio/sdk",
    "modal",
    "playwright-core",
  ],
  experimental: {
    // Enable PPR for progressive rendering of agent streams
    ppr: false,
  },
};

export default nextConfig;
