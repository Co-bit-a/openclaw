---
summary: "Use Companion to track local service ports and audit project directories"
read_when:
  - You run several local projects that may claim the same TCP port
  - You want OpenClaw to check declared ports before starting a service
  - You want a read-only review of stale, disposable-looking, or duplicate projects
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
