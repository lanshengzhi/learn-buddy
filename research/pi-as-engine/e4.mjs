// E4 — credential/settings lock behaviour: does pi self-heal an orphan lock?
// Uses pi's real SettingsManager write path (proper-lockfile lockSync, stale default 10s)
// and reproduces pi's async auth-lock options (stale 30s) with the same library.
// Usage: node e4.mjs init | write <label> | hold <ms> | stale-lock <ageMs> | async-lock-probe <ageMs>
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

// the exact library+version pi itself imports for its locks
const require = createRequire(import.meta.url);
const lockfile = require(
  "/home/lansy/Work/LearnBuddy/ai-service/node_modules/@earendil-works/pi-coding-agent/node_modules/proper-lockfile/index.js",
);

const LAB = "/home/lansy/Work/LearnBuddy/.scratch/pi-lab";
const AGENT_DIR = `${LAB}/agentdir`;
const CWD = LAB;
const SETTINGS = path.join(AGENT_DIR, "settings.json");
const AUTH = path.join(AGENT_DIR, "auth.json");
const mode = process.argv[2];

function nowStamp() {
  return new Date().toISOString().slice(11, 23);
}

if (mode === "init") {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS)) fs.writeFileSync(SETTINGS, "{}\n");
  if (!fs.existsSync(AUTH)) fs.writeFileSync(AUTH, "{}\n");
  console.log(`settings=${SETTINGS} exists=${fs.existsSync(SETTINGS)}`);
  console.log(`auth=${AUTH} exists=${fs.existsSync(AUTH)}`);
  console.log(`lock paths: ${SETTINGS}.lock (dir) / ${AUTH}.lock (dir)`);
} else if (mode === "write") {
  const label = process.argv[3] ?? "x";
  const t0 = Date.now();
  const mgr = SettingsManager.create(CWD, AGENT_DIR);
  await mgr.reload();
  mgr.setHideThinkingBlock(!mgr.getHideThinkingBlock());
  try { await mgr.flush(); } catch (e) { console.log(`flush threw ${e.code}`); }
  // SettingsManager records lock failures internally instead of throwing:
  // enqueueWrite(...).catch(err => this.recordError(scope, err))  (settings-manager.js:356-368)
  const errors = (mgr.drainErrors?.() ?? []).map((e) => `${e.scope}:${e.error?.code ?? e.error?.message}`);
  const ok = errors.length === 0;
  console.log(
    `[${nowStamp()}] ${label}: ${ok ? "WRITE OK" : "WRITE FAILED (recorded as a diagnostic)"} in ${Date.now() - t0} ms` +
      `${ok ? "" : " -> drainErrors=" + JSON.stringify(errors)}` +
      ` ; file=${fs.readFileSync(SETTINGS, "utf8").trim()} ; lockdir=${fs.existsSync(SETTINGS + ".lock")}`,
  );
} else if (mode === "hold") {
  const ms = Number(process.argv[3] ?? 60000);
  // same options pi's acquireLockSyncWithRetry uses: lockSync(path, { realpath: false })
  const release = lockfile.lockSync(SETTINGS, { realpath: false });
  console.log(`[${nowStamp()}] holder pid=${process.pid} acquired ${SETTINGS}.lock (holding ${ms} ms)`);
  setTimeout(() => {
    try {
      release();
    } catch {}
    console.log(`[${nowStamp()}] holder released`);
    process.exit(0);
  }, ms);
} else if (mode === "stale-lock") {
  const ageMs = Number(process.argv[3] ?? 60000);
  const lockDir = `${SETTINGS}.lock`;
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.mkdirSync(lockDir);
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(lockDir, old, old);
  console.log(`[${nowStamp()}] pre-aged lock dir mtime by ${ageMs} ms`);
} else if (mode === "async-lock-probe") {
  // Reproduces pi's async auth lock options exactly:
  // stale: 30_000, retries: 0, realpath: false  (dist/core/auth-storage.js:85-90)
  const ageMs = Number(process.argv[3] ?? 0);
  const lockDir = `${AUTH}.lock`;
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.mkdirSync(lockDir);
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(lockDir, old, old);
  const t0 = Date.now();
  try {
    const release = await lockfile.lock(AUTH, { realpath: false, retries: 0, stale: 30_000 });
    console.log(`[${nowStamp()}] async lock (stale=30000, age=${ageMs}ms): ACQUIRED in ${Date.now() - t0} ms`);
    await release();
  } catch (error) {
    console.log(`[${nowStamp()}] async lock (stale=30000, age=${ageMs}ms): ${error.code} after ${Date.now() - t0} ms`);
  }
}
process.exit(0);
