// E4 — edit-and-reload behaviour: after changing an extension file on disk, does
// pi pick the change up (a) on a second loader.reload(), (b) in a brand-new
// DefaultResourceLoader with the same cwd+agentDir, (c) only in a fresh process?
//
// Usage: node e4-reload.mjs
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
const LAB = process.env.PI_EXT_LAB || path.resolve(HERE, "..", "..", ".scratch", "pi-ext-lab");
const ROOT = path.join(LAB, "e4");
const AGENT_DIR = path.join(ROOT, "agentdir");
const CWD = path.join(ROOT, "project");
const EXT = path.join(ROOT, "ext", "which-version.ts");

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(AGENT_DIR, { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(path.dirname(EXT), { recursive: true });
fs.copyFileSync(path.join(LAB, "agentdir", "models.json"), path.join(AGENT_DIR, "models.json"));
for (const f of ["auth.json", "models-store.json", "settings.json"]) fs.writeFileSync(path.join(AGENT_DIR, f), "{}");

const version = Number(process.env.EXT_VERSION || 1);
const writeExt = (v) =>
  fs.writeFileSync(
    EXT,
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "version_tool_v${v}",
    label: "v${v}",
    description: "version marker ${v}",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "v${v}" }], details: {} }; },
  });
}
`,
  );

async function activeTools(loader, label) {
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
  console.log(`${label}: ${JSON.stringify(session.getActiveToolNames())}`);
}

const makeLoader = () =>
  new DefaultResourceLoader({
    cwd: CWD,
    agentDir: AGENT_DIR,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [EXT],
    systemPromptOverride: () => "harness",
  });

writeExt(1);
const loaderA = makeLoader();
await loaderA.reload();
await activeTools(loaderA, "process start, file v1, loaderA.reload()#1");

writeExt(2);
console.log("--- file rewritten to v2 ---");
const loaderD = makeLoader();
await loaderD.reload();
await activeTools(loaderD, "brand-new loaderD, no prior reload");
await loaderA.reload();
await activeTools(loaderA, "loaderA.reload()#2 after edit    ");
const loaderB = makeLoader();
await loaderB.reload();
await activeTools(loaderB, "brand-new loaderB, same cwd      ");
const loaderC = new DefaultResourceLoader({
  cwd: path.join(ROOT, "other-project"),
  agentDir: AGENT_DIR,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  additionalExtensionPaths: [EXT],
  systemPromptOverride: () => "harness",
});
await loaderC.reload();
await activeTools(loaderC, "new loaderC, different cwd       ");
