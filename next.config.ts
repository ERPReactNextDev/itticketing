import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // bcrypt ships a native binding, so it must stay outside the bundler rather
  // than be traced into the server bundle.
  serverExternalPackages: ["bcrypt"],
  experimental: {
    // CSV payloads for the requestor importer can get large.
    serverActions: { bodySizeLimit: "8mb" },
  },
};

export default nextConfig;
