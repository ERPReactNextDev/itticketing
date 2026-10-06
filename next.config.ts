import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Mongoose / the MongoDB driver must stay outside the bundler so the
  // connection pool survives across route handler invocations.
  serverExternalPackages: ["mongoose", "mongodb", "bcrypt"],
  experimental: {
    // CSV payloads for the requestor importer can get large.
    serverActions: { bodySizeLimit: "8mb" },
  },
};

export default nextConfig;