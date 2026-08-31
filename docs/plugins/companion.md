---
summary: "Use Companion to track ports, audit projects, and keep an opt-in browser journal"
read_when:
  - You run several local projects that may claim the same TCP port
  - You want OpenClaw to check declared ports before starting a service
  - You want a read-only review of stale, disposable-looking, or duplicate projects
  - You want a bounded local record of web pages exposed by the Chrome extension
title: "Companion"
---

# Companion

Companion is a disabled-by-default local personal-assistant plugin. Its first capability keeps a
persistent registry of the TCP ports your projects intend to use, then compares those declarations
with the computer's active listeners.

Companion is advisory. It does not start, stop, kill, or reconfigure processes.

## Enable the plugin

```bash
openclaw plugins enable companion
```

Restart the gateway after enabling the plugin.

## Agent tools

`companion_port_registry` registers, updates, or removes a `(project, service)` declaration. A
registration contains a TCP port and an optional short note. Registering the same project and
service again updates its declaration.

`companion_ports` compares the registry with active local TCP listeners. It reports:

- duplicate declarations, when multiple project services claim the same port;
- occupied registered ports and the listening process name and PID when available;
- registered ports that are currently free;
- a count of active listeners that are not registered.

Ask for `includeUnregistered` only when the full unregistered-listener list is useful. The default
response keeps that potentially noisy process inventory out of normal conversations.

Listener inspection uses `lsof` on macOS and Linux and `netstat` on Windows. If inspection is not
available, the registry remains readable and the tool returns a scan error instead of discarding
the declarations.

## Project audit

`companion_project_audit` performs a read-only scan inside the current agent workspace. It discovers
directories with common project markers, such as `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`,
or `go.mod`, and reports projects that deserve manual review because they are stale, have a name that
resembles a demo/test/copy/backup/temp project, or exactly match another project's bounded content
fingerprint.

Roots are workspace-relative and cannot escape through `..`, absolute paths, or symlinks. Generated
and dependency directories such as `.git`, `node_modules`, `dist`, `build`, virtual environments, and
caches are not traversed. Scan depth, project count, files, and bytes are bounded.

The audit does not call a project abandoned merely because it is old, and it never moves or deletes
anything. Treat every result as evidence for manual review.

## Passive browser recording

`companion_browser_capture` controls an opt-in background recorder. It is off by default even when
the Companion plugin is enabled. Start it explicitly to poll the built-in `chrome` extension profile
every 30 seconds, or choose another extension-backed profile, interval, and per-page text limit.
`stop` pauses future polls without deleting existing records, while `capture_now` runs one bounded
poll immediately.

Passive recording accepts extension-backed browser profiles only. This preserves the Chrome
extension's hard exclusion for incognito windows; a managed CDP or existing-session profile is
rejected before tabs are listed.

Each poll reads at most eight eligible HTTP or HTTPS tabs and extracts visible page prose without
navigating, clicking, or changing the page. Pages with URL credentials are excluded; query strings
and fragments are not stored. Unchanged content is deduplicated, and the local record store evicts
its oldest entry after 2,000 entries. `companion_browser_history` returns up to 20 recent matching
records and marks all page-controlled content as external and untrusted before it reaches the agent.

The recorder also excludes sensitive URLs before requesting page text and checks again after text
extraction in case the tab navigated. Protected categories include authentication and account pages,
banking, brokerage, payment, portfolio, trading, and wallet paths, URLs carrying credential-like
parameters, and local or private-network hosts. Exclusions are fixed safety boundaries and cannot be
overridden by tool parameters. Capture summaries report the number of protected tabs without
returning their titles, URLs, or text.

Tab eligibility still follows the Chrome extension's access controls. Pause a tab in the extension,
or use Selected tabs mode, when it should not be exposed to OpenClaw. The recorder does not start
merely because the extension or Companion plugin is active.
