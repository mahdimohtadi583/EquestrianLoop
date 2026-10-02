// Provide fallback env vars at build time to prevent module load errors
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://build:build@localhost:5432/build'
process.env.DIRECT_URL = process.env.DIRECT_URL || 'postgresql://build:build@localhost:5432/build'

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Security headers for production
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-XSS-Protection",
            value: "1; mode=block",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "geolocation=(), microphone=(), camera=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },

  // Content Security Policy header (strict but allows necessary sources)
  async redirects() {
    return [];
  },
};

export default nextConfig;
