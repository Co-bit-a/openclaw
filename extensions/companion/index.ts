import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCompanionBrowserCaptureTools } from "./src/browser-capture-tool.js";
import {
  BrowserCaptureService,
  type BrowserCaptureRecord,
  type BrowserCaptureSettings,
} from "./src/browser-capture.js";
import type { PortRegistration } from "./src/ports.js";
import { createCompanionProjectAuditTool } from "./src/project-audit-tool.js";
import { createCompanionPortTools } from "./src/tools.js";

const MAX_PORT_REGISTRATIONS = 512;
const MAX_BROWSER_CAPTURE_RECORDS = 2_000;

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
    const browserCaptureSettings = api.runtime.state.openKeyedStore<BrowserCaptureSettings>({
      namespace: "browser-capture-settings",
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
    const browserCaptureRecords = api.runtime.state.openKeyedStore<BrowserCaptureRecord>({
      namespace: "browser-capture-records",
      maxEntries: MAX_BROWSER_CAPTURE_RECORDS,
      overflowPolicy: "evict-oldest",
    });
    const browserCapture = new BrowserCaptureService({
      settings: browserCaptureSettings,
      records: browserCaptureRecords,
      gateway: {
        call: async (method, params, options) =>
          await api.runtime.gateway.request(method, params, options),
      },
    });

    api.registerService({
      id: "companion-browser-capture",
      start: async (context) => await browserCapture.start(context.logger),
      stop: () => browserCapture.stop(),
    });

    api.registerTool(
      (context) => {
        if (context.senderIsOwner !== true) {
          return null;
        }
        const tools = createCompanionPortTools({ registrations });
        tools.push(...createCompanionBrowserCaptureTools(browserCapture));
        if (context.workspaceDir) {
          tools.push(createCompanionProjectAuditTool(context.workspaceDir));
        }
        return tools;
      },
      {
        names: [
          "companion_ports",
          "companion_port_registry",
          "companion_project_audit",
          "companion_browser_capture",
          "companion_browser_history",
        ],
        optional: true,
      },
    );
  },
});
