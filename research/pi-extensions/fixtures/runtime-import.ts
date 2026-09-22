import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const tool = defineTool({
    name: "runtime_import_probe",
    label: "runtime import probe",
    description: "proves a runtime (non-type) import of the published package works from an extension",
    parameters: Type.Object({ m: Type.String() }),
    async execute(_id, params) { return { content: [{ type: "text", text: `ok:${params.m}` }], details: {} }; },
  });
  pi.registerTool(tool);
}
