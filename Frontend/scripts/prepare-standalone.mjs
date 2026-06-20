// After `next build` (output: 'standalone'), Next emits .next/standalone/server.js
// with a minimal node_modules but does NOT copy the static assets or /public into
// it. Electron serves the standalone dir directly, so copy them in here.
//
//   node scripts/prepare-standalone.mjs
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const standalone = join(root, ".next", "standalone");

if (!existsSync(join(standalone, "server.js"))) {
  console.error(
    "[prepare-standalone] .next/standalone/server.js not found — run `next build` " +
      "with output:'standalone' first.",
  );
  process.exit(1);
}

// .next/static  →  .next/standalone/.next/static
const staticSrc = join(root, ".next", "static");
const staticDst = join(standalone, ".next", "static");
if (existsSync(staticSrc)) {
  mkdirSync(dirname(staticDst), { recursive: true });
  cpSync(staticSrc, staticDst, { recursive: true });
  console.log("[prepare-standalone] copied .next/static");
}

// public  →  .next/standalone/public
const publicSrc = join(root, "public");
const publicDst = join(standalone, "public");
if (existsSync(publicSrc)) {
  cpSync(publicSrc, publicDst, { recursive: true });
  console.log("[prepare-standalone] copied public/");
}

console.log("[prepare-standalone] standalone bundle ready at .next/standalone");
