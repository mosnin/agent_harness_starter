# hades

Local MCP plugin for conversation-to-conversation delegation. Install this plugin directory in a compatible local Codex/ChatGPT Work client. Requires Node 22+, the updated Hades runtime, and configured provider access. Browser use also requires Hades Browser paired with the runtime.

The server discovers `~/.hades/browser-runtime.json`. Set `HADES_DATA_DIR` or `HADES_RUNTIME_DESCRIPTOR` for a custom installation. It verifies private descriptor permissions, uses loopback bearer authentication, and exports only delegate/status/continue/cancel. It cannot approve its own actions.

A cloud-only ChatGPT session cannot access this local process; a supported local plugin host is required. This plugin does not register Hades as a built-in Chrome replacement. It lets the conversation delegate browser outcomes and supervise them through Hades.
