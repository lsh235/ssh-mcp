# Shell MCP

Read [AGENTS.md](../AGENTS.md) for repository and remote-development instructions.
For installation and client configuration, follow [docs/AI_SETUP.md](../docs/AI_SETUP.md).

The deployment is A (AI client) -> HTTPS MCP on B -> persistent OpenSSH shell on C.
SSH credentials belong to B. Remote project files on C are canonical.
Discover the server's tools before using them; retain session/request/command IDs.
Never automatically re-execute an unknown command or input. A reopened session is a fresh shell.
Keep credentials out of Git and conversations. The server needs no AI API key.
Verify actual MCP tool calls before reporting that a client is connected.

For a browser view of this conversation's SSH work, follow [docs/VSCODE_BROWSER.md](../docs/VSCODE_BROWSER.md). Call create_session_view with only this conversation's SSH IDs. Return/open the resulting URL and let the user authenticate privately. Never send real tokens to browser tools. Use run_command.displayName for a non-secret command summary.
