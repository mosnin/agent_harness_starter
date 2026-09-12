# Optional Hades runtime integrations

These `hades-plugin-v1` manifests use Hades' existing MCP transport and tool approvals. They are optional adapters, not bundled third-party runtimes. Import the manifest through Extensions, inspect it, then enable it. Hades does not silently download or run a second computer-control service.

- `context-mode.json`: install `context-mode@1.0.169` on the runtime PATH first. The server is launched in the conversation's project and receives `CONTEXT_MODE_PROJECT_DIR` from Hades. The parent conversation and ordinary Work agents can retrieve context and pass relevant material into Helm. Scoped built-in Helm workers do not launch arbitrary MCP processes. External Codex/Claude/OpenCode workers require their own context-mode MCP configuration; host-specific compaction hooks are not installed by this manifest. Upstream declares Elastic-2.0; review its terms before redistributing it in a hosted product.
- `open-computer-use.json`: install the upstream `open-computer-use` binary and grant its macOS permissions. Hades launches `open-computer-use mcp`. All exposed MCP calls remain subject to Hades' approval layer. Avoid running two input-driving agents concurrently. Native Hades computer control remains available and now supplies post-action observations.

Ponytail, ECC and HumanLayer skills are bundled separately in `third_party/conversation-skills` and require no external MCP process. Their exact upstream reference files can be read through `skill_reference`. The source registry records revisions and licenses.
