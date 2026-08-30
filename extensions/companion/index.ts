import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { PortRegistration } from "./src/ports.js";
import { createCompanionProjectAuditTool } from "./src/project-audit-tool.js";
import { createCompanionPortTools } from "./src/tools.js";

const MAX_PORT_REGISTRATIONS = 512;

export default definePluginEntry({
  id: "companion",
  name: "Companion",
  description:
    "Local personal-assistant utilities for understanding and managing work across projects.",
  register(api) {
    const registrations = api.runtime.state.openKeyedStore<PortRegistration>({
      namespace: "port-registrations",
      maxEntries: MAX_PORT_REGISTRATIONS,
      overflowPolicy: "reject-new",
    });

    api.registerTool(
      (context) => {
        if (context.senderIsOwner !== true) {
          return null;
        }
        const tools = createCompanionPortTools({ registrations });
        if (context.workspaceDir) {
          tools.push(createCompanionProjectAuditTool(context.workspaceDir));
        }
        return tools;
      },
      {
        names: ["companion_ports", "companion_port_registry", "companion_project_audit"],
        optional: true,
      },
    );
  },
});
