# Shell MCP

Read [AGENTS.md](../AGENTS.md) for repository and remote-development instructions.
For installation and client configuration, follow [docs/AI_SETUP.md](../docs/AI_SETUP.md).

The deployment is A (AI client) -> HTTPS MCP on B -> persistent OpenSSH shell on C.
SSH credentials belong to B. Remote project files on C are canonical.
Discover the server's tools before using them; retain session/request/command IDs.
Never automatically re-execute an unknown command or input. A reopened session is a fresh shell.
Keep credentials out of Git and conversations. The server needs no AI API key.
Verify actual MCP tool calls before reporting that a client is connected.
