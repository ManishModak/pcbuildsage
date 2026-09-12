import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  turbopack: {
    root: __dirname
  },
  webpack: (config) => {
    config.watchOptions = {
      ...config.watchOptions,
      ignored: [
        "**/node_modules/**",
        "**/.git/**",
        "**/data/*.db*",
        "**/data/*.sqlite*",
        "**/data/logs/**",
        "**/.venv/**",
      ]
    };
    return config;
  }
};

export default nextConfig;
