// E1 — the loading question: can DefaultResourceLoader be pointed at a local
// TypeScript file we wrote ourselves, with noExtensions left false, and have it
// actually jiti-loaded and its registrations applied?
//
// Usage:
//   node e1-load.mjs                        # files in <repo>/research/pi-extensions/ext
//   node e1-load.mjs <dir>                  # files in <dir>
//   node e1-load.mjs <dir> notools=builtin  # same, but createAgentSession options
//   node e1-load.mjs <dir> noext            # noExtensions: true (negative control)
//
// `notools=` accepts: none | all | builtin | allow  (allow -> tools: [<custom names>])
//
// No provider traffic: this script never calls session.prompt().
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const DEFAULT_LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".scratch", "pi-ext-lab");
const LAB = process.env.PI_EXT_LAB || DEFAULT_LAB;
const AGENT_DIR = path.join(LAB, "agentdir");

const args = process.argv.slice(2);
const dirArg = args.find((a) => !a.includes("=") && a !== "noext");
const modeArg = args.find((a) => a.startsWith("notools="));
const noToolsMode = modeArg ? modeArg.split("=")[1] : "auto";
const NO_EXT = args.includes("noext");

const EXT_DIR = dirArg ? path.resolve(dirArg) : path.join(HERE, "ext");
const isExtFile = (f) => /\.(ts|mts|js|mjs|cts|cjs)$/.test(f);
// additionalExtensionPaths may point at files or at a directory containing them.
const EXT_PATHS = fs.statSync(EXT_DIR).isDirectory()
  ? fs.readdirSync(EXT_DIR).filter(isExtFile).sort().map((f) => path.join(EXT_DIR, f))
  : [EXT_DIR];

console.log(`ext dir       : ${EXT_DIR}`);
console.log(`ext paths     : ${EXT_PATHS.map((f) => path.basename(f)).join(", ") || "(none)"}`);
console.log(`noExtensions  : ${NO_EXT}`);
console.log(`notools mode  : ${noToolsMode}`);

const loader = new DefaultResourceLoader({
  cwd: REPO,
  agentDir: AGENT_DIR,
  noExtensions: NO_EXT,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  additionalExtensionPaths: EXT_PATHS,
  systemPromptOverride: () => "You are a test harness.",
});

let reloadThrew = null;
try {
  await loader.reload();
} catch (error) {
  reloadThrew = error;
}

const result = loader.getExtensions();
console.log(`\nreload() threw : ${reloadThrew ? `${reloadThrew.name}: ${reloadThrew.message}` : "no"}`);
console.log(`result keys    : ${JSON.stringify(Object.keys(result))}`);
console.log(`extensions[]   : ${result.extensions?.length ?? "(n/a)"}`);
console.log(`errors[]       : ${JSON.stringify(result.errors ?? null)}`);
for (const e of result.extensions ?? []) {
  console.log(`   loaded ${path.basename(e.path)}`);
}

const modelRuntime = await ModelRuntime.create({
  authPath: path.join(AGENT_DIR, "auth.json"),
  modelsStorePath: path.join(AGENT_DIR, "models-store.json"),
  modelsPath: path.join(AGENT_DIR, "models.json"),
});
const model = modelRuntime.getModel("mock", "mock-model");

const sessionOptions = { cwd: REPO, sessionManager: SessionManager.inMemory(REPO), modelRuntime, model, resourceLoader: loader };
if (noToolsMode === "all") sessionOptions.noTools = "all";
if (noToolsMode === "builtin") sessionOptions.noTools = "builtin";
if (noToolsMode === "allow") sessionOptions.tools = ["lb_word_lookup", "lb_reading_position", "tb_echo"];

const { session, extensionsResult } = await createAgentSession(sessionOptions);

console.log(`\nsession.extensionsResult === loader result : ${extensionsResult === result}`);
console.log(`active tools : ${JSON.stringify(session.getActiveToolNames())}`);
console.log(`all tools    : ${JSON.stringify(session.getAllTools().map((t) => t.name))}`);
for (const name of ["lb_word_lookup", "lb_reading_position", "tb_echo"]) {
  const def = session.getToolDefinition(name);
  console.log(`getToolDefinition(${name}) : ${def ? "present" : "ABSENT"}`);
}

const factoryLog = path.join(LAB, "tool-invocations.log");
const gateLog = path.join(LAB, "gate.log");
console.log(`factory log  : ${fs.existsSync(factoryLog) ? fs.readFileSync(factoryLog, "utf8").trim().split("\n").join(" | ") : "(absent)"}`);
console.log(`gate log     : ${fs.existsSync(gateLog) ? fs.readFileSync(gateLog, "utf8").trim().split("\n").join(" | ") : "(absent)"}`);
