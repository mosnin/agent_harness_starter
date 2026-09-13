# Hades conversation architecture and upstream research

## Decision

Hades should expose one conversation as the durable owner of an outcome. Work is the scheduler behind that conversation; Helm is its coding execution and review capability; Browser is a controlled execution surface. These are implementation capabilities, not modes the person must choose before asking for help. A task can begin with plain language, continue through tools and collaborating workers, and conclude with inspectable artifacts in the same thread.

The existing repositories already contain substantial parts of this architecture. Replacing them with another harness would duplicate persistence, ownership, permission and recovery behavior. The useful integration strategy is selective: carry over portable skills, reuse runtime boundaries for optional MCP services, and adapt proven behavior where the existing product has a demonstrated gap.

## Current Hades evidence

The desktop baseline is `mosnin/agent_harness_starter` at `43fdf5cd1a1c51e3baea3f85e1232102f249fefa`. `src/desktop/core/workbench-service.ts` constructs the tool registry for an ordinary chat and attaches Work, Helm, Orca, browser, app, file and computer capabilities. `chat-guidance.ts` already instructs the model to perform the work in the conversation. `SessionMeta` retains delegated Work goals, Helm runs and Orca intents. These IDs are the correct continuity mechanism.

`durable-work.ts` implements a real concurrent worker pool, task dependencies, persisted messages, reservations, output checks and recovery. This is more than a visual board. However, internal messaging was difficult to inspect from a running worker and task controls were weak in the parent chat. The changes add a scoped worker inbox and conversation actions for team guidance and resumption within an existing allocation. Peer text is coordination data; it cannot grant different tool permissions.

The browser baseline is `mosnin/hades-browser` at `47a42324d478d3e746022b0af031bd5b3dbae368`. Its `AgentPanel.tsx` already contains a transcript, run cards and composer, but first use selected Tasks and supplementary views unmounted the composer. The change makes conversation the default and keeps the composer and draft alive while inspecting supporting material. A successful send returns attention to the transcript.

These are source and test observations. They do not prove the currently installed Mac app has the new code, provider access, account grants, or completed end-to-end execution.

## Integration matrix

| Project | Useful mechanism | Decision | Delivery boundary |
|---|---|---|---|
| Open Codex Computer Use | App-scoped accessibility snapshots, per-app actions, fresh state after actions, bounded tree/text output | Adopt fresh post-action observation in Hades; provide optional MCP integration | Native Hades bridge stays intact; external binary is not bundled or silently installed |
| Fortress | Separate patched Chromium engine with CDP and SDK/MCP interfaces | Optional independent execution engine candidate | Not an Electron library or an immediate replacement for the visible browser |
| ECC | Search before coding, verification, security review, team ownership and evidence | Bundle four selected skills with provenance | No global hooks, shell profiles, telemetry or parallel scheduler replacement |
| Ponytail | Reuse-first implementation ladder and minimal changes without omitting explicit requirements | Bundle skill; apply to Helm coding prompts | User task and Hades authority take precedence |
| context-mode | MCP retrieval, indexed output, project/session continuity | Provide explicit optional MCP manifest | Existing Hades context archive remains; upstream runtime and host hooks need separate validation |
| HumanLayer skills | Instruction refinement, React type narrowing, visual explanation, control-loop/workflow authoring | Bundle five skills and their accompanying reference files | Invoking a skill does not automatically deploy workflows or create schedules |
| Tencent BrowserSkill | Existing-session automation, semantic targeting, browser evaluation fixtures | Retain Hades native bridge; use as a source for further behavioral tests | Do not introduce an extension plus daemon alongside equivalent native transport |
| QM | Personal/shared scope ownership, portable harness boundaries, scoped skills and durable coordination | Architectural reference | No replacement of Hades with QM's web/Slack/Postgres service |
| Helium | Chromium privacy defaults, tab lifecycle, simpler browser chrome, patch-oriented maintenance | Learn from policies; retain existing browser implementation | No copying of GPL-specific patches into the current MPL browser |

## Open Codex Computer Use

The repository exposes `list_apps`, `get_app_state`, click, secondary action, scroll, drag, type, key and set-value tools through a Swift MCP server. `ComputerUseToolDispatcher.swift` maps inputs to a shared `ComputerUseService`; `AccessibilitySnapshot.swift` carries actual accessibility element records and configurable tree limits. The usage reference documents default bounded text output and refreshed state after actions. This is a concrete control loop improvement: the result of an action should contain the state needed for the next decision.

Hades already protects issued snapshots using a turn-local identity and a global epoch; it consumes a snapshot before dispatch and refuses concurrent native bridge operations. Replacing that with a second global input driver would risk competing cursors and stale observations. The source change preserves those protections and attempts a new observation after a successful native dispatch. If that observation fails, the result says the action was dispatched but its visible result was not obtained. It does not retry the action.

The optional integration manifest launches `open-computer-use mcp` through Hades' existing MCP transport. This can expose app-oriented capabilities once the binary is installed and macOS access is granted. The fixture and smoke suite in upstream are useful candidates for later live regression scenarios, but no upstream smoke pass is claimed here. The repository's MIT license is retained as source provenance; the native engine has not been copied into Hades.

## Fortress

Fortress is a Chromium engine with native patches and a CDP endpoint. Its Node SDK `sdk/node/index.js` resolves platform assets, selects a release channel, obtains checksums, caches a binary and launches it. `mcp/server.py` is another automation access layer. The SDK includes native platform asset names while its source comments also mention Docker fallback; this is a reason to verify the actual release artifact on the target Mac rather than infer compatibility from a platform table.

It cannot simply be placed inside the browser's React UI to replace Electron's embedded Chromium. An engine replacement would affect process hosting, profile data, extensions, permission mediation, downloads, passkeys, code signing, update cadence and the existing tool host. A separate optional CDP runtime is the smaller experiment. It must be clearly identified as a different browser session and must not imply it has the user's current Hades Browser logins.

The published detector results and stealth claims are upstream claims, not reproduced results. They do not establish general browsing reliability, website permission, or authentication compatibility. No detector-bypass claim is part of Hades acceptance. Before adopting this engine, validate launch/stop, CDP disconnect recovery, profile isolation, bounded resource use and one representative authorized task. Native engine packaging is deferred from this source change.

## ECC

ECC is a broad collection of agent skills, commands, hooks, memory and orchestration tooling. The useful portion is not the total file count. Its `verification-loop` calls for build, types, lint, tests and diff inspection before a readiness statement. `search-first` encourages finding existing implementations. `security-review` provides review coverage, and `team-agent-orchestration` describes ownership, separate assignments, evidence and merge gates.

These four skills are copied at a pinned revision, with the MIT notice, into `third_party/conversation-skills`. They appear in Hades' skill inventory and can be selected through `/skill`. Their content is not all injected into every turn. The skill name and content are resolved from the selected profile's actual installed/bundled library.

The shell hooks, tmux orchestrator, global Git hooks and automated learning hooks are not automatically activated. They have side effects and overlap Hades' own execution journal, task scheduler, context archive and approval layer. ECC's state-file orchestration patterns are useful evidence for explicit handoffs, but adopting a second scheduler would worsen the very fragmentation this redesign removes. A later extraction should target a demonstrated missing behavior and carry a focused regression check.

## Ponytail

Ponytail is a prompt skill rather than a runtime. Its ladder prefers an existing code path, standard library or native platform feature before adding a dependency or abstraction. The same skill explicitly says not to simplify away input validation, accessibility, error handling, or requirements the user asked for. That qualification is important for Hades: minimal implementation must still support all the requested work.

The skill is bundled and appended to Helm's coding prompt after the concrete task. The wrapper states that the user's instructions take precedence and that the discipline is scoped to this task. `/skill ponytail` also makes it selectable in ordinary chat. The associated source SHA and MIT license are included. This does not mean upstream benchmark claims have been reproduced for Hades.

## context-mode

`src/server.ts` exposes tools including indexed retrieval and controlled output processing. `src/store.ts` and session modules persist and retrieve relevant material rather than requiring the model to absorb every raw result. The source includes project attribution, session event extraction, native SQLite handling and client-specific hooks. Its Codex example explicitly pins project context when automatic session discovery is unreliable.

Hades already uses `FileContextArchive` in its agent loop and exact-reference context reads. That implementation should not be removed. The immediate adapter is an optional Hades MCP manifest; server processes start in the selected project, and `CONTEXT_MODE_PROJECT_DIR` is explicitly set by the host to that project. The integration must not infer a different project from an unrelated Codex session on the same machine. A parent conversation can retrieve material and pass it into Helm; the scoped built-in Helm child does not directly launch MCP services. External coding harnesses require their own MCP configuration.

The inspected package is version 1.0.169 and declares Elastic License 2.0. Its license restricts some hosted/managed-service uses. This report does not make a legal compatibility determination. The source change does not relicense or embed the implementation; shipping it as part of a hosted product requires a separate decision. MCP connectivity also does not imply all upstream platform hooks are installed or that advertised token reduction applies to Hades. Validate retrieval quality and session isolation with actual Hades tool outputs before making those claims.

## HumanLayer skills

The inspected repository contains five skills: `improve-claude-md`, `narrow-react-prop-types`, `build-iterated-agentic-loop`, `design-control-loop` and `show-me`. The first two improve existing implementation/instructions; `show-me` is useful for explaining an agent's proposed changes. The workflow skills are relevant when the user explicitly asks to build an automated coding loop.

All five are bundled with MIT provenance and their reference files. The reference TypeScript is excluded from Hades' own compilation because it is template material for another environment. The control-loop skills should not become persistent autonomous behavior merely by being present. The model must still obtain an actual task, produce reviewable changes, and use the host's permitted tools. Scheduled operation remains an explicit outcome, not an incidental hook.

## Tencent BrowserSkill

BrowserSkill combines an extension, CLI and protocol so shell-capable agents can interact with an existing logged-in browser. Its source includes semantic/visual object handling, long screenshot capture and browser-evaluation fixtures. Those are useful comparators for target freshness, non-interruption, screenshot completeness and action-result reporting.

Hades Browser already has a native tool host, paired agent channel, page snapshots and stale-reference checks. Adding BrowserSkill's extension and daemon by default would create two authorities over the same browser. The recommended extraction is behavioral: retain the native channel and add specific regression cases for stale targets, background work, interrupted actions and long pages. The current browser patch also prevents idle-tab reclamation from discarding tabs that active agents own.

No claim is made that every BrowserSkill feature is equivalent to Hades. Long screenshot stitching, cross-browser extension support and upstream evaluation tasks remain possible follow-up integrations when their product value is demonstrated.

## QM

QM separates people and rooms into scopes with their own state, tools and credentials. Its source has dedicated scope resolution, scoped storage keys and skill materialization components. The repository supports multiple coding harnesses behind a shared core, and its README distinguishes durable Postgres mode from ephemeral in-process sessions. These are useful architectural boundaries for collaboration.

Hades already has profile identity, Work ownership, a team service and A2A modules. The correct translation is to retain one parent conversation, preserve task provenance, and route peer messages through owned plans. It is not to embed QM's full Slack/web/admin infrastructure in a desktop panel. That would add deployment and identity surfaces before solving the local journey.

The new external-conversation boundary allows a local compatible client to delegate and supervise a Hades conversation through a narrow API. Idempotent request IDs are persisted before admission so an uncertain retry does not launch duplicate work. This boundary is task delegation; it is not a claim of complete interoperability with every A2A implementation.

## Helium

Helium is a Chromium patch-based browser. Relevant files include `memory-saving-by-default.patch`, `webrtc-default-handling-policy.patch`, native bang handling, tab hibernation controls and simplified browser chrome. The memory patch changes the default memory-saver state; the WebRTC patch changes a browser preference. These files are concrete source evidence, not merely marketing claims.

The transferable insight is to make resource and privacy policies intentional while preserving user activity. Hades already implements idle suspension. The new protection keeps live agent-owned tabs from being reclaimed, and releases that protection when the run finishes. This applies the lifecycle principle to an agent browser instead of mechanically copying another browser's default.

Helium-specific code is licensed under GPL-3.0, while the Hades Browser repository declares MPL-2.0. No Helium patch was copied. A wholesale engine/patch adoption would require a separate licensing and distribution review as well as Chromium compatibility work. The report does not certify legal compatibility.

## Plugin boundary and acceptance

`hades` and `hades-browser` are local MCP plugins with delegate, status, continue and cancel tools. They discover the running Hades runtime through a private same-user descriptor, connect only to loopback, authenticate with its token, and cannot invoke arbitrary desktop RPC or approve their own actions. Browser delegation restricts the created conversation to Hades Browser tools; subsequent messages retain that scope.

These plugins do not change the ChatGPT/Codex host's built-in browser implementation. A local plugin-capable host can ask Hades to perform browser work and supervise the resulting conversation. A cloud-only session cannot reach a Mac's loopback service without a separately supported secure connection. Installation and host discovery are separate from manifest validation.

Source tests, renderer tests and local UI inspection establish bounded implementation behavior. Release acceptance still requires the updated packaged applications, real account/provider access, a multi-agent task with peer communication, a browser task using an authorized logged-in session, a coding change reviewed and committed through the intended path, and interruption/restart recovery. The task ledger and evidence should remain in the conversation throughout those checks.

## Sources

All source checkouts were resolved on 2026-09-12. The identifiers below pin the inspected code. Upstream READMEs and performance assertions are not independent acceptance evidence.

- [iFurySt/open-codex-computer-use](https://github.com/iFurySt/open-codex-computer-use/tree/386a260d1ab8b690adbbb27f7471595cf0c2b752) — `386a260d1ab8b690adbbb27f7471595cf0c2b752`.

- [tiliondev/fortress](https://github.com/tiliondev/fortress/tree/58607300e0aaaf007b5b0c8e195af60385593ffb) — `58607300e0aaaf007b5b0c8e195af60385593ffb`.

- [affaan-m/ECC](https://github.com/affaan-m/ECC/tree/8321021c54d670126ce3b2969d5deb880b4b0c2a) — `8321021c54d670126ce3b2969d5deb880b4b0c2a`.

- [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/356918eba965ee1eac64bd3a7f0dd02108350de5) — `356918eba965ee1eac64bd3a7f0dd02108350de5`.

- [mksglu/context-mode](https://github.com/mksglu/context-mode/tree/1530c370f5789f6e53d633f2b06c8b883aca49fb) — `1530c370f5789f6e53d633f2b06c8b883aca49fb`.

- [humanlayer/skills](https://github.com/humanlayer/skills/tree/3c2629142c5d437428269b1b722b08c0b87f574d) — `3c2629142c5d437428269b1b722b08c0b87f574d`.

- [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill/tree/72876cc20b1cc4f3a34f9dd8a48b2e7e91f0d08f) — `72876cc20b1cc4f3a34f9dd8a48b2e7e91f0d08f`.

- [yc-software/qm](https://github.com/yc-software/qm/tree/234022fd5c9245002339815b4944c7c6cfd8a578) — `234022fd5c9245002339815b4944c7c6cfd8a578`.

- [imputnet/helium](https://github.com/imputnet/helium/tree/52d17a26f29b6a86dde7730e49e825cc98437a3c) — `52d17a26f29b6a86dde7730e49e825cc98437a3c`.

## Context-mode runtime acceptance (2026-09-12 local evening)

Pinned npm `context-mode@1.0.169` was installed in a disposable local prefix with `--ignore-scripts`, without global installation, hook setup, or changes to user profiles. Hades' real `connectMcp` transport discovered 11 tools. Two disposable project roots sharing one disposable data directory indexed different facts under the same source name. Each default search returned its own fact and excluded the other. Closing and reconnecting the first server preserved retrieval. Both the initial probe and the checked-in reproduction passed.

Reproduce after installing that exact package locally: `npx tsx scripts/check-context-mode.ts /absolute/path/to/context-mode/cli.bundle.mjs`. The test creates its own temporary project/data roots and retains `evidence.json`. It never calls execute, fetch, upgrade, purge, or insight. This proves default project attribution and restart retrieval, not a security boundary: upstream search supports global/explicit project scope and the optional server exposes code execution. Hades approvals still apply. The optional integration remains disabled by default; it has not been silently enabled in a user profile or bundled into the app. Elastic License 2.0 distribution review remains separate.

## Fortress platform probe (2026-09-13)

Inspected npm `tilion-fortress@151.0.7910` and the live GitHub release asset lists. The API's latest release was `v150.0.7871.114` (Linux x64 only). SDK channels point to `v149.0.7827.232` and `v151.0.7908.0`; both provide Linux x64 and Windows x64 assets, but neither provides macOS. The SDK resolves this Mac as `mac-arm64`, checks for a native asset, then falls back to Docker. An actual bounded `Fortress.launch({channel:'latest',port:19443})` probe failed with “No native binary for this platform yet and Docker not installed.” No browser/container was started and no profile was imported.

Source findings prevent using the default launcher unchanged in Hades: Docker uses `-p PORT:9222` without a loopback bind; native launches share `CACHE/profile`; missing checksum metadata only warns and permits extraction; CDP readiness accepts whichever service already answers on the chosen port. A Hades-owned adapter would need loopback-only exposure, unique task profiles, mandatory integrity verification, endpoint ownership checks, and cleanup after failed startup. Those changes are requirements, not implemented or accepted features. Launch/stop, disconnect recovery, and resource acceptance remain blocked on an available engine/runtime. Do not replace the existing Hades Browser engine or imply shared login state.

Sources: [release assets](https://github.com/tiliondev/fortress/releases), [Node SDK](https://github.com/tiliondev/fortress/blob/main/sdk/node/index.js). This probe makes no detector-bypass or broad compatibility claim.
