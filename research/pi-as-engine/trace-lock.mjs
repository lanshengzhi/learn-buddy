import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

function patch(label, obj) {
  for (const m of ["writeFileSync", "rmdirSync", "mkdirSync", "utimesSync", "unlinkSync", "renameSync"]) {
    if (typeof obj[m] !== "function") continue;
    const orig = obj[m].bind(obj);
    obj[m] = (...args) => {
      const p = typeof args[0] === "string" ? args[0] : "";
      if (p.includes("settings.json")) {
        const st = new Error().stack.split("\n").slice(1, 4).map((s) => s.trim().replace(/^at\s+/, "").split(" ")[0]).join(" <- ");
        console.log(`  [${label}] ${m}(${p.replace(/.*pi-lab\//, "")})  ${st}`);
      }
      return orig(...args);
    };
  }
}
patch("node:fs", fs);
const gfs = require("/home/lansy/Work/LearnBuddy/ai-service/node_modules/@earendil-works/pi-coding-agent/node_modules/graceful-fs");
patch("graceful-fs", gfs);

const S = "/home/lansy/Work/LearnBuddy/.scratch/pi-lab/agentdir/settings.json";
const L = S + ".lock";
fs.rmSync(L, { recursive: true, force: true });
fs.writeFileSync(S, JSON.stringify({ hideThinkingBlock: false }, null, 2) + "\n");
fs.mkdirSync(L);
const lockfile = require("/home/lansy/Work/LearnBuddy/ai-service/node_modules/@earendil-works/pi-coding-agent/node_modules/proper-lockfile/index.js");
console.log("lock exists:", fs.existsSync(L), "checkSync:", lockfile.checkSync(S, { realpath: false }));

const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
const mgr = SettingsManager.create("/home/lansy/Work/LearnBuddy/.scratch/pi-lab", "/home/lansy/Work/LearnBuddy/.scratch/pi-lab/agentdir");
await mgr.reload();
console.log("--- setter ---");
mgr.setHideThinkingBlock(true);
await mgr.flush();
console.log("drainErrors:", (mgr.drainErrors?.() ?? []).map((e) => `${e.scope}: ${e.error?.code} ${e.error?.message?.split("\n")[0]}`));
console.log("file now:", fs.readFileSync(S, "utf8").trim());
console.log("lock exists after:", fs.existsSync(L));
