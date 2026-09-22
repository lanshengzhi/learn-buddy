// E6 — resuming a stored session without passing a model: does the model come back from the session?
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
const LAB = "/home/lansy/Work/LearnBuddy/.scratch/pi-lab";
const AGENT_DIR = `${LAB}/agentdir`;
const loader = new DefaultResourceLoader({ cwd: LAB, agentDir: AGENT_DIR, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPromptOverride: () => "t" });
await loader.reload();
const modelRuntime = await ModelRuntime.create({ authPath: `${AGENT_DIR}/auth.json`, modelsStorePath: `${AGENT_DIR}/models-store.json`, modelsPath: `${AGENT_DIR}/models.json` });
const path = fs.readFileSync(`${LAB}/e1-session-path.txt`, "utf8").trim();
const { session, modelFallbackMessage } = await createAgentSession({
  cwd: LAB,
  sessionManager: SessionManager.open(path),
  modelRuntime,
  resourceLoader: loader,
  tools: [],
});
console.log(`resumed without an explicit model -> session.model = ${session.model ? `${session.model.provider}/${session.model.id}` : "NONE"}`);
console.log(`modelFallbackMessage = ${modelFallbackMessage ?? "(none)"}`);
console.log(`restored messages = ${session.agent.state.messages.length}`);
await session.prompt("does the restored model work?");
console.log(`reply = ${(session.agent.state.messages.at(-1).content ?? []).map((p) => p.text ?? "").join("").slice(0, 80)}`);
session.dispose();
process.exit(0);
