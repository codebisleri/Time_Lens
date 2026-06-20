// electron-builder afterPack hook.
//
// The Next.js standalone output (`.next/standalone`) bundles a minimal
// `node_modules` (next, react, …) that the server REQUIRES at runtime. Copying it
// via electron-builder `extraResources` silently drops that `node_modules`
// (electron-builder's node_modules file-filtering leaks into the resource copy),
// which left the installed app with `Cannot find module 'next'`.
//
// To guarantee a COMPLETE, self-contained copy we do it ourselves here, after
// electron-builder finishes packing — a plain recursive fs copy with no
// filtering: `.next/standalone/*` → `<app>/resources/web/` (server.js,
// package.json, node_modules/, .next/static/, public/, everything).
const { cpSync, existsSync } = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const projectDir =
    (context.packager && context.packager.info && context.packager.info.projectDir) ||
    process.cwd();
  const standalone = path.join(projectDir, ".next", "standalone");
  const staticSrc = path.join(projectDir, ".next", "static");
  const publicSrc = path.join(projectDir, "public");
  const dest = path.join(context.appOutDir, "resources", "web");

  if (!existsSync(standalone)) {
    throw new Error(
      `[after-pack] Next standalone not found at ${standalone} — run \`npm run build:web\` first.`,
    );
  }
  if (!existsSync(path.join(standalone, "node_modules"))) {
    throw new Error(
      `[after-pack] ${standalone}\\node_modules is missing — the standalone build is incomplete.`,
    );
  }

  // 1. The full standalone payload (server.js, package.json, node_modules,
  //    .next/server, …) — a plain recursive copy, no filtering.
  cpSync(standalone, dest, { recursive: true });

  // 2. Static + public copied DIRECTLY from their canonical sources, so the
  //    bundle is complete even if `prepare-standalone` didn't run (a bare
  //    `next build` regenerates standalone WITHOUT these).
  if (existsSync(staticSrc)) {
    cpSync(staticSrc, path.join(dest, ".next", "static"), { recursive: true });
  }
  if (existsSync(publicSrc)) {
    cpSync(publicSrc, path.join(dest, "public"), { recursive: true });
  }

  // Fail loud if the critical pieces didn't land — never ship a broken bundle.
  for (const rel of ["server.js", "node_modules/next", ".next/static", "public"]) {
    if (!existsSync(path.join(dest, rel))) {
      throw new Error(`[after-pack] resources/web is incomplete — missing ${rel}`);
    }
  }
  console.log(`[after-pack] copied complete Next standalone → ${dest}`);
};
