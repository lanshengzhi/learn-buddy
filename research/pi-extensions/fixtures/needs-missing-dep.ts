import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ms from "no-such-pkg-xyz-42";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "missing_pkg_probe",
    label: "missing pkg probe",
    description: "probe",
    parameters: { type: "object", properties: { d: { type: "string" } }, required: ["d"] },
    async execute(_id, params) {
      return { content: [{ type: "text", text: String(ms(params.d)) }], details: {} };
    },
  });
}
