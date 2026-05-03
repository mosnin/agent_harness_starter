import type { NextConfig } from "next";

const SERVER_ONLY_PACKAGES = [
  "@openai/agents",
  "composio-core",
  "@daytonaio/sdk",
  "@opentelemetry/sdk-node",
  "@opentelemetry/exporter-logs-otlp-grpc",
  "@opentelemetry/otlp-grpc-exporter-base",
  "@grpc/grpc-js",
  "@grpc/proto-loader",
  "@iarna/toml",
  "modal",
  "playwright-core",
  "@browserbasehq/sdk",
  "@pinecone-database/pinecone",
  "@supabase/supabase-js",
  "convex",
  "@prisma/client",
];

const nextConfig: NextConfig = {
  serverExternalPackages: SERVER_ONLY_PACKAGES,

  webpack(config, { isServer }) {
    if (isServer) {
      // Mark optional server-only packages as external for all server contexts
      // (instrumentation.ts is not a Server Component so serverExternalPackages alone
      //  doesn't cover it — we add them to webpack externals directly too).
      const existing = Array.isArray(config.externals)
        ? config.externals
        : config.externals
          ? [config.externals]
          : [];

      config.externals = [
        ...existing,
        // Catch @prisma/ and .prisma/ sub-paths (generated client files)
        ({ request }: { request?: string }, callback: (err?: null, result?: string) => void) => {
          if (
            request &&
            (request.startsWith(".prisma/") ||
              request.startsWith("@prisma/") ||
              SERVER_ONLY_PACKAGES.some((pkg) => request === pkg || request.startsWith(pkg + "/")))
          ) {
            return callback(null, `commonjs ${request}`);
          }
          callback();
        },
      ];
    } else {
      // Client bundle: replace Node-only modules with empty stubs
      config.resolve = config.resolve ?? {};
      config.resolve.fallback = {
        ...(config.resolve.fallback as object | undefined),
        path: false,
        fs: false,
        os: false,
        zlib: false,
        stream: false,
        net: false,
        tls: false,
        crypto: false,
        child_process: false,
        async_hooks: false,
        http2: false,
        dns: false,
      };
    }
    return config;
  },

  experimental: {
    ppr: false,
  },
};

export default nextConfig;
