import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { PortRegistration } from "./src/ports.js";
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
        return createCompanionPortTools({ registrations });
      },
      {
        names: ["companion_ports", "companion_port_registry"],
        optional: true,
      },
    );
  },
});
