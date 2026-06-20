// Spawns and supervises the two server processes Time Lens needs:
//   1. the FastAPI backend  (PyInstaller backend.exe when packaged; venv python in dev)
//   2. the Next.js standalone server (only when packaged; `next dev` runs it in dev)
// Plus loopback readiness polling and guaranteed teardown.
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = 8000;
const WEB_HOST = "127.0.0.1";
const WEB_PORT = 3000;

/** @type {import('child_process').ChildProcess[]} */
const children = [];

function log(...a) {
  console.log("[backend-launcher]", ...a);
}

/** Poll a URL until it answers (any HTTP status) or we time out. */
function waitForUrl(url, { timeoutMs = 90000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${url}`));
        else setTimeout(tick, intervalMs);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tick();
  });
}

function pipeLogs(child, tag) {
  child.stdout?.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[${tag}] ${d}`));
  child.on("exit", (code, sig) => log(`${tag} exited (code=${code} sig=${sig})`));
}

/**
 * Start the FastAPI backend.
 * @param {{ isPackaged: boolean, resourcesPath: string, appRoot: string, dataDir: string, electronExec: string }} ctx
 */
async function startBackend(ctx) {
  const env = {
    ...process.env,
    TIMELENS_HOST: BACKEND_HOST,
    TIMELENS_PORT: String(BACKEND_PORT),
    TIMELENS_DATA_DIR: ctx.dataDir, // %APPDATA%/Time Lens — writable
    TIMELENS_DB_PATH: path.join(ctx.dataDir, "dhisha_segments.db"),
    STREAMLIT_SERVER_HEADLESS: "true",
  };

  const isWin = process.platform === "win32";
  let child;
  if (ctx.isPackaged) {
    // Frozen backend shipped under resources/backend/ (PyInstaller onedir):
    //   Windows → backend.exe · macOS/Linux → backend (no extension).
    const exeName = isWin ? "backend.exe" : "backend";
    const exe = path.join(ctx.resourcesPath, "backend", exeName);
    if (!fs.existsSync(exe)) throw new Error(`backend executable missing at ${exe}`);
    log("starting packaged backend:", exe);
    child = spawn(exe, [], { cwd: path.dirname(exe), env, windowsHide: true });
  } else {
    // Dev: run backend_main.py with the project venv's python.
    //   Windows → venv\Scripts\python.exe · macOS/Linux → venv/bin/python.
    const backendDir = path.resolve(ctx.appRoot, "..", "Backend");
    const venvPy = isWin
      ? path.join(backendDir, "venv", "Scripts", "python.exe")
      : path.join(backendDir, "venv", "bin", "python");
    const py = fs.existsSync(venvPy) ? venvPy : isWin ? "python" : "python3";
    log("starting dev backend:", py, "backend_main.py");
    child = spawn(py, ["backend_main.py"], { cwd: backendDir, env, windowsHide: true });
  }
  pipeLogs(child, "backend");
  children.push(child);

  // FastAPI always serves /openapi.json once the app has booted.
  await waitForUrl(`http://${BACKEND_HOST}:${BACKEND_PORT}/openapi.json`);
  log("backend ready");
}

/**
 * Start the Next.js server. Packaged → run the standalone server.js with
 * Electron's bundled Node (ELECTRON_RUN_AS_NODE). Dev → no-op (`next dev` is
 * launched by `npm run desktop`).
 * @param {{ isPackaged: boolean, resourcesPath: string, electronExec: string }} ctx
 */
async function startWeb(ctx) {
  if (!ctx.isPackaged) {
    log("dev mode — Next served by `next dev`, waiting for it");
    await waitForUrl(`http://${WEB_HOST}:${WEB_PORT}`);
    return;
  }
  const serverJs = path.join(ctx.resourcesPath, "web", "server.js");
  if (!fs.existsSync(serverJs)) throw new Error(`Next server missing at ${serverJs}`);
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1", // run the Electron binary as plain Node
    PORT: String(WEB_PORT),
    HOSTNAME: WEB_HOST,
    NODE_ENV: "production",
  };
  log("starting packaged Next server:", serverJs);
  const child = spawn(ctx.electronExec, [serverJs], {
    cwd: path.dirname(serverJs),
    env,
    windowsHide: true,
  });
  pipeLogs(child, "web");
  children.push(child);
  await waitForUrl(`http://${WEB_HOST}:${WEB_PORT}`);
  log("web ready");
}

function stopAll() {
  log("stopping", children.length, "child process(es)");
  for (const c of children.splice(0)) {
    try {
      if (process.platform === "win32" && c.pid) {
        // Kill the whole tree (backend.exe spawns workers; node has none but be safe).
        spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true });
      } else {
        c.kill("SIGTERM");
      }
    } catch (e) {
      log("kill failed:", e?.message);
    }
  }
}

module.exports = {
  startBackend,
  startWeb,
  stopAll,
  WEB_URL: `http://${WEB_HOST}:${WEB_PORT}`,
  BACKEND_URL: `http://${BACKEND_HOST}:${BACKEND_PORT}`,
};
