// E3 — *where* extensions can come from, and the no-file alternative.
//
// Cases (each in its own scratch project dir + agent dir, so they cannot
// interfere):
//   agentdir   : <agentDir>/extensions/*.ts        (global discovery)
//   project    : <cwd>/.pi/extensions/*.ts         (project discovery)
//   dirpath    : additionalExtensionPaths: [<dir>] (directory, not file list)
//   subdir     : <dir>/<name>/index.ts             (folder convention)
//   factory    : extensionFactories: [fn]          (inline, no file, no jiti)
//   none       : nothing anywhere                  (negative control)
//
// Usage: node e3-discovery.mjs <case>
// No provider traffic.
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
const DEFAULT_LAB = path.resolve(HERE, "..", "..", ".scratch", "pi-ext-lab");
const LAB = process.env.PI_EXT_LAB || DEFAULT_LAB;
const CASE = process.argv[2] ?? "none";
const ROOT = path.join(LAB, "e3", CASE);
const AGENT_DIR = path.join(ROOT, "agentdir");
const CWD = path.join(ROOT, "project");

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(AGENT_DIR, { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
fs.copyFileSync(path.join(LAB, "agentdir", "models.json"), path.join(AGENT_DIR, "models.json"));
fs.writeFileSync(path.join(AGENT_DIR, "auth.json"), "{}");
fs.writeFileSync(path.join(AGENT_DIR, "models-store.json"), "{}");
fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), "{}");

const SRC = fs.readFileSync(path.join(HERE, "ext", "learnbuddy-tools.ts"), "utf8");

function plant(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SRC);
  return file;
}

let additionalExtensionPaths = [];
let extensionFactories = [];

if (CASE === "agentdir") plant(path.join(AGENT_DIR, "extensions", "agent-ext.ts"));
else if (CASE === "project") plant(path.join(CWD, ".pi", "extensions", "project-ext.ts"));
else if (CASE === "dirpath") {
  const dir = path.join(LAB, "e3", "shared-ext");
  plant(path.join(dir, "one.ts"));
  additionalExtensionPaths = [dir];
} else if (CASE === "subdir") {
  const dir = path.join(LAB, "e3", "subdir-ext");
  plant(path.join(dir, "myext", "index.ts"));
  additionalExtensionPaths = [dir];
} else if (CASE === "subdir-index") {
  // folder convention under a *discovered* location
  plant(path.join(AGENT_DIR, "extensions", "myext", "index.ts"));
} else if (CASE === "subdir-path") {
  // folder passed directly in additionalExtensionPaths (needs index resolution)
  const dir = path.join(LAB, "e3", "subdir-index-ext");
  plant(path.join(dir, "myext", "index.ts"));
  additionalExtensionPaths = [path.join(dir, "myext")];
} else if (CASE === "jspath") {
  // a *real* plain-JS extension passed in additionalExtensionPaths
  const dir = path.join(LAB, "e3", "js-ext");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plain.js"),
    `export default function (pi) {
  pi.registerTool({
    name: "js_tool",
    label: "JS Tool",
    description: "registered from a plain .js extension file",
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    async execute(_id, params) { return { content: [{ type: "text", text: "js:" + params.q }], details: {} }; },
  });
}
`,
  );
  additionalExtensionPaths = [path.join(dir, "plain.js")];
} else if (CASE === "factory-noext") {
  extensionFactories = [
    (pi) => {
      pi.registerTool({
        name: "inline_factory_tool",
        label: "Inline Factory Tool",
        description: "registered from an in-process factory while noExtensions is true",
        parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        async execute(_id, params) {
          return { content: [{ type: "text", text: `inline:${params.q}` }], details: {} };
        },
      });
    },
  ];
} else if (CASE === "factory") {
  extensionFactories = [
    (pi) => {
      pi.registerTool({
        name: "inline_factory_tool",
        label: "Inline Factory Tool",
        description: "registered from an in-process factory, no file involved",
        parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        async execute(_id, params) {
          return { content: [{ type: "text", text: `inline:${params.q}` }], details: {} };
        },
      });
    },
  ];
}

const loader = new DefaultResourceLoader({
  cwd: CWD,
  agentDir: AGENT_DIR,
  noExtensions: CASE === "factory-noext",
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  additionalExtensionPaths,
  extensionFactories,
  systemPromptOverride: () => "You are a test harness.",
});
await loader.reload();
const result = loader.getExtensions();

const modelRuntime = await ModelRuntime.create({
  authPath: path.join(AGENT_DIR, "auth.json"),
  modelsStorePath: path.join(AGENT_DIR, "models-store.json"),
  modelsPath: path.join(AGENT_DIR, "models.json"),
});
const { session } = await createAgentSession({
  cwd: CWD,
  sessionManager: SessionManager.inMemory(CWD),
  modelRuntime,
  model: modelRuntime.getModel("mock", "mock-model"),
  resourceLoader: loader,
  noTools: "builtin",
});

console.log(`case            : ${CASE}   (cwd=${CWD})`);
console.log(`extensions      : ${result.extensions.length}  errors=${JSON.stringify(result.errors)}`);
for (const e of result.extensions) console.log(`   loaded ${e.path}`);
console.log(`active tools    : ${JSON.stringify(session.getActiveToolNames())}`);
