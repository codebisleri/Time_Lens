import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Desktop packaging: emit a self-contained Node server at
  // `.next/standalone/server.js` (+ minimal node_modules) that Electron runs
  // with its bundled Node runtime. Keeps middleware/auth/SSR intact — no static
  // export. Harmless for the normal `next start` web deployment.
  output: "standalone",
  // Serve images straight from /public with NO runtime optimizer. The desktop
  // (Electron standalone) runtime has no `/_next/image` optimization server +
  // `sharp`, and the large DhishaAI wordmark (9400×3000) made the optimizer
  // fail → broken-image placeholder. Unoptimized = plain <img> to the original
  // asset, which renders identically in dev, `next start`, standalone, and
  // Electron. The brand PNGs are already small on disk, so there's no cost.
  images: { unoptimized: true },
  // The frontend is fully decoupled from the backend. When the real API
  // exists, point NEXT_PUBLIC_API_BASE_URL at it (or proxy via rewrites).
  async rewrites() {
    const apiBase = process.env.API_PROXY_TARGET;
    if (!apiBase) return [];
    return [
      {
        source: "/api/:path*",
        destination: `${apiBase}/:path*`,
      },
    ];
  },
};

export default nextConfig;
