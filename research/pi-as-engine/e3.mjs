// E3 — two SEPARATE PROCESSES appending to the SAME stored session file.
// Usage: node e3.mjs make | writer <label> | inspect
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";

const LAB = "/home/lansy/Work/LearnBuddy/.scratch/pi-lab";
const AGENT_DIR = `${LAB}/agentdir`;
const SESSIONS = `${LAB}/sessions`;
const CWD = LAB;
const POINTER = `${LAB}/e3-session-path.txt`;
fs.mkdirSync(SESSIONS, { recursive: true });

async function makeSession(manager) {
  const loader = new DefaultResourceLoader({
    cwd: CWD,
    agentDir: AGENT_DIR,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => "You are a test harness.",
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: `${AGENT_DIR}/auth.json`,
    modelsStorePath: `${AGENT_DIR}/models-store.json`,
    modelsPath: `${AGENT_DIR}/models.json`,
  });
  const { session } = await createAgentSession({
    cwd: CWD,
    sessionManager: manager,
    modelRuntime,
    model: modelRuntime.getModel("mock", "mock-model"),
    resourceLoader: loader,
    tools: [],
  });
  return session;
}

const mode = process.argv[2];

if (mode === "make") {
  const s = await makeSession(SessionManager.create(CWD, SESSIONS));
  await s.prompt("seed turn");
  fs.writeFileSync(POINTER, s.sessionFile);
  console.log(`created ${s.sessionFile}`);
  s.dispose();
} else if (mode === "writer") {
  const label = process.argv[3] ?? "x";
  const file = fs.readFileSync(POINTER, "utf8").trim();
  const s = await makeSession(SessionManager.open(file));
  console.log(`[${label}] pid=${process.pid} opened, restored=${s.agent.state.messages.length} msgs, leaf=${SessionManager.open(file).getLeafEntry()?.id}`);
  await s.prompt(`turn from ${label}`);
  console.log(`[${label}] pid=${process.pid} done, msgs=${s.agent.state.messages.length}`);
  s.dispose();
} else if (mode === "inspect") {
  const file = fs.readFileSync(POINTER, "utf8").trim();
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const entries = lines.map((l) => JSON.parse(l));
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  const children = new Map();
  for (const e of entries) {
    if (!e.id) continue;
    const p = e.parentId ?? null;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(e.id);
  }
  const leaves = [...byId.keys()].filter((id) => !children.has(id));
  console.log(`file=${file}`);
  console.log(`lines=${lines.length} entries=${entries.length} header=${entries[0].type} version=${entries[0].version}`);
  console.log(`distinct ids=${byId.size} (duplicates=${entries.filter((e) => e.id).length - byId.size})`);
  console.log(`leaves=${leaves.length}: ${leaves.join(", ")}`);
  const forks = [...children.entries()].filter(([, kids]) => kids.length > 1);
  console.log(`fork points (entries with >1 child) = ${forks.length}`);
  for (const [parent, kids] of forks) console.log(`   parent ${parent} -> ${kids.join(", ")}`);
  for (const e of entries) {
    const label = e.type === "message" ? `${e.message.role}: ${JSON.stringify(e.message.content).slice(0, 40)}` : e.type;
    console.log(`   ${e.id ?? "(header)"} parent=${e.parentId ?? "-"} ${label}`);
  }
  // what does a fresh open see?
  const reopened = SessionManager.open(file);
  console.log(`reopen: entries=${reopened.getEntries().length} leaf=${reopened.getLeafEntry()?.id} path=${reopened.getPath().length}`);
}
process.exit(0);
