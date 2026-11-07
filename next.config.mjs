/** @type {import('next').NextConfig} */
const config = {
  output: "standalone",
  poweredByHeader: false,
  outputFileTracingExcludes: {
    "/*": ["./.local/**/*", "./var/**/*", "./backups/**/*", "./.env*"],
  },
  serverExternalPackages: ["pg"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
export default config;
