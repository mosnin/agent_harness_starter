# Centaur and Hades Slack agents

Centaur at `d3143c354ea4df79f40961d8b0fe1b910caee286` offers Slack conversations, per-thread Kubernetes sandboxes, a harness server, durable workflows, replayable events and credential injection through iron-proxy. Its root license is `Apache-2.0 OR MIT`. See the [upstream repository](https://github.com/paradigmxyz/centaur) and [license](https://github.com/paradigmxyz/centaur/blob/d3143c354ea4df79f40961d8b0fe1b910caee286/LICENSE).

Hades currently implements its own desktop Slack bridge informed by these requirements. It does **not** embed Centaur's control plane, run Kubernetes, or provide iron-proxy's network credential boundary. No Centaur source code has been copied into this bridge. A Hades profile's selected local project remains the execution workspace; host command and write approvals remain in the desktop app.

## Connect a Slack workspace

1. Open **More → Slack** in Hades. Select the Hades agent and local project to use.
2. Expand Connection settings, copy the app manifest, and open Slack apps. Create an app from the manifest in the intended workspace. Workspace administrators may need to approve installation.
3. Install the app and copy its `xoxb-` bot token. Generate an app-level `xapp-` token with `connections:write` for Socket Mode. The manifest enables Socket Mode and subscribes only to `app_mention`.
4. Invite the bot into the desired channels. Save both tokens in Hades. They are stored in macOS Keychain and restored directly into the sidecar; status responses never contain tokens.
5. Enter allowed channel IDs and allowed member IDs. Use **List bot channels** to see the bot's channel memberships. Slack member profiles expose **Copy member ID**. Empty allowlists deny all requests and cannot be saved.
6. Save settings, then Connect. Mention the bot in an allowed channel, for example `@Hades summarize README.md`. Progress and final answers appear in that thread. Use Open conversation in Hades for tools, approvals and full history.

The selected project may contain private material. Only authorize channel members who should be able to request reads from that project. Hades does not automatically grant write or shell approvals to Slack users. The connection operates while Hades is open and the Mac is awake. Restarting Hades requires reconnecting from this screen; it does not silently resume an interrupted agent turn.

The implementation follows Slack's [Socket Mode protocol](https://docs.slack.dev/apis/events-api/using-socket-mode/), [channel membership API](https://docs.slack.dev/reference/methods/users.conversations/) and [message update API](https://docs.slack.dev/reference/methods/chat.update/). Socket Mode needs no public webhook. This setup is a workspace app installation, not a public Slack Marketplace listing.

## Persistence and failure behavior

- The SQLite inbox is under the Hades data directory's `slack` folder. Each accepted event is committed before its Socket Mode envelope is acknowledged. Duplicate event IDs cannot start another turn.
- Workspace, channel, thread, agent profile and project identity determine the persistent conversation. Requests are processed serially; another member cannot silently switch the chosen project through their message.
- A known progress message is updated for final delivery. Retrying a completed reply updates the same Slack timestamp and never repeats inference.
- Queued requests survive restart. An in-flight request is marked failed on restart, with its local conversation retained for inspection. A network failure during initial progress delivery may leave an uncertain progress message, but the agent is not automatically rerun.
- A reply cannot be published after reconnecting to a different Slack workspace. Revoked channels or members are rechecked before queued work starts.
- Socket disconnections reconnect with bounded backoff. A socket that never sends hello is replaced. HTTP errors and Slack `ok:false` are failures, never delivery confirmations.

Automated tests use local protocol fixtures. A separate workbench integration test sends a Slack event through the real agent loop and HTTP model fixture, verifies the write approval, declines it, checks the file remains absent, and checks the threaded reply. This is not live Slack installation or model-provider acceptance.

## Centaur-specific work remaining

The Kubernetes sandbox allocator, iron-proxy egress credential injection, Centaur API/event-stream adapter, workflow sleep/resume/child-agent engine, and organization overlay deployment are not ported. Hades' existing backend, scheduling, hierarchy and governance commands are available through the Harness screen, but they do not establish Centaur runtime parity. Those capabilities need separate integration and live deployment verification.
