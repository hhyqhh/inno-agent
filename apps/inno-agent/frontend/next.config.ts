import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pure static SPA: `next build` produces static files in `out/`.
  // We never run `next start` and there is no SSR. Incoming browsers hit
  // `baseURL + '/api'` directly (see lib/api/config.ts).
  output: "export",
  trailingSlash: true,
  reactStrictMode: true,
  images: {
    // Static export does not run the image optimizer; ship real URLs through.
    unoptimized: true,
  },
  turbopack: {
    // The frontend is its own npm package (its own nested .git), so pin the
    // Turbopack root here — it otherwise falls back to the monorepo root and
    // warns about an ignored package.json.
    root: process.cwd(),
  },
};

export default nextConfig;
