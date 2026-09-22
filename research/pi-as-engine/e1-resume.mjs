// E1 — can pi resume a *stored* session as a library, across separate processes?
// Usage: node e1-resume.mjs new | resume | list
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";

const LAB = "/home/lansy/Work/LearnBuddy/.scratch/pi-lab";
const AGENT_DIR = `${LAB}/agentdir`;
const SESSIONS = `${LAB}/sessions`;
const CWD = LAB; // cwd bounds the built-in tools
const POINTER = `${LAB}/e1-session-path.txt`;
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
  const model = modelRuntime.getModel("mock", "mock-model");
  const { session } = await createAgentSession({
    cwd: CWD,
    sessionManager: manager,
    modelRuntime,
    model,
    resourceLoader: loader,
    tools: ["read", "bash", "edit", "write"], // tools ON, unlike the deployed service
  });
  return { session, modelRuntime };
}

const mode = process.argv[2] ?? "new";
const stamp = () => new Date().toISOString().slice(11, 23);

if (mode === "new") {
  const { session } = await makeSession(SessionManager.create(CWD, SESSIONS));
  console.log(`[${stamp()}] created sessionFile=${session.sessionFile} sessionId=${session.sessionId}`);
  await session.prompt("first question");
  console.log(`[${stamp()}] messages after turn 1 = ${session.agent.state.messages.length}`);
  fs.writeFileSync(POINTER, session.sessionFile);
  session.dispose();
  console.log(`[${stamp()}] wrote pointer ${POINTER}`);
} else if (mode === "resume") {
  const file = fs.readFileSync(POINTER, "utf8").trim();
  const manager = SessionManager.open(file);
  console.log(`[${stamp()}] opened ${file}; entries=${manager.getEntries().length}`);
  const { session } = await makeSession(manager);
  console.log(
    `[${stamp()}] resumed sessionId=${session.sessionId} restoredMessages=${session.agent.state.messages.length}`,
  );
  for (const m of session.agent.state.messages) {
    const text = Array.isArray(m.content)
      ? m.content.map((p) => p.text ?? `[${p.type}]`).join("")
      : String(m.content);
    console.log(`   ${m.role}: ${text.slice(0, 90)}`);
  }
  await session.prompt("second question");
  const last = session.agent.state.messages[session.agent.state.messages.length - 1];
  console.log(`[${stamp()}] after turn 2 messages=${session.agent.state.messages.length}`);
  console.log(`   reply: ${(last.content ?? []).map((p) => p.text ?? "").join("").slice(0, 140)}`);
  session.dispose();
} else if (mode === "list") {
  const infos = await SessionManager.list(CWD, SESSIONS);
  console.log(`listed ${infos.length} session(s) in ${SESSIONS}`);
  for (const i of infos) {
    console.log(
      `  id=${i.id} path=${i.path} firstMessage="${String(i.firstMessage).slice(0, 40)}" modified=${i.modified?.toISOString?.() ?? i.modified}`,
    );
  }
}
process.exit(0);
