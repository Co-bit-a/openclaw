---
summary: "Use Companion to track local service ports across projects and detect collisions"
read_when:
  - You run several local projects that may claim the same TCP port
  - You want OpenClaw to check declared ports before starting a service
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
