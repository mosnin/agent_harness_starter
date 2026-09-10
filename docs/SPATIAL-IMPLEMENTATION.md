# Hades spatial development workflow

Candidate built on September 10, 2026. Hades now includes Maus as a native helper, a conversation capture/review interface, Browser element context and workflows, and reviewed visual input for Helm. These features are implemented and have bounded automated evidence. Complete native interaction acceptance is still open; the final section lists the exact remaining gates.

## Use the candidate

Built applications on this Mac:

- Hades with embedded Maus: `/Users/preston/Documents/Codex/2026-09-06/hades-repair/dist-mac/Hades.app`
- Hades Browser: `/Users/preston/Documents/Codex/2026-09-07/hades-browser-audit/release/spatial-candidate/mac-arm64/Hades Browser.app`
- Standalone Maus candidate: `/tmp/hadesmaus-spatial-candidate/HadesMaus.app`

The previously installed `/Applications/HadesMaus.app` was not replaced or restarted during this implementation. Quit a standalone Maus normally before using the managed helper; Hades refuses an existing native runtime publication instead of starting two apps against the same library. An enabled external Maus MCP connection remains supported. If a crash left a discovery file, opening and quitting standalone Maus normally clears it. Hades does not delete another runtime's discovery or credentials.

1. Open a project and conversation in Hades. Select **Point at something** above the composer.
2. Use **Maus** to point/gesture/speak, select its latest capture, use the desktop capture's three-second switch delay, or inspect a page in the paired Hades Browser and choose an observed element.
3. Review the images and captured text. Add an annotation. Exclude images/text or mask private regions in a single image. Save review before attaching. Masking changes the saved pixels and removes structural text; a CSS overlay is only the pending preview.
4. **Attach to composer** adds exact capture revisions to the next message. Nothing is sent until the normal message action. A **Helm draft** is a separate explicit action; it does not start a coding run. Start the draft from Helm after choosing its coding agent and reviewing the task.
5. Capture the result and choose a baseline for comparison. Comparisons require matching source/window or Browser tab/workspace/URL/viewport identity. Pixel counts and structural changes are inspection evidence, not automatic proof of correct behavior. A missing comparison is displayed as **not compared**.
6. For Browser workflows, start recording, perform the sequence, stop and inspect it, then explicitly replay. For native movies, choose **Record window** in the Maus menu/workspace and optionally enable workflow metadata. Ask Hades's approved `maus` tool for the stored workflow or timestamp frames. See the Maus repository's `docs/20-hades-spatial-integration.md` for exact native calls and guided-execution limits.

## Implemented boundaries

| Capability | Implementation and limits |
|---|---|
| Conversation spatial input | Screenshots, point/voice context and DOM/AX metadata retained together. Server-derived ownership binds every read, review and handoff to a conversation, profile and canonical project. |
| Review and privacy | Explicit review revisions, cancellation, five-image bound, physical exclusion/redaction, untrusted screen-data labeling, private local files and scoped deletion of unshared captures. Shared/draft evidence is retained. Library is bounded at 100 captures and 256 MB. |
| Element to code context | Browser returns an observed element's role/name, box, viewport, styles and explicit developer source attributes. Hades verifies that a hinted source file exists inside the selected project. A component match is labeled **unverified**; this is not universal source-map/component resolution. |
| Helm input | Immutable scoped draft; repeated admission is idempotent. Built-in Hades receives reviewed images. External CLIs get temporary image files inside the isolated worktree; Codex and OpenCode receive their image/file flags. Cleanup checks directory identity and excludes these assets from the proposed diff. |
| Browser recording | Opt-in trusted human clicks/scrolls or approved agent actions; no input values or keystrokes. Durable bounded journal, run/tab/workspace ownership, visible stop, permission rechecks, fresh unique targets and no automatic retry of unknown outcomes. |
| Native recording | Actual stored-MOV frame extraction with calibrated movie time, size/dimension/token bounds and cancellation. Passive input metadata is opt-in. Each supported current AX button requires approval; original-click target fidelity is explicitly unverified. Scroll/text/gaps require manual handling. |
| Native integration | Maus bundled beside the signed Hades runtime. Lazy managed startup, no automatic standalone bridge launch, publication readiness, close/cancel propagation, expected-parent checks and serialized native shutdown. External configured MCP remains available. |
| Maus experience | Existing premium workspace, warm Hades palette, orange-red flaming-pointer identity and hover notch island are included in this native build. The Hades spatial view uses the existing light/dark theme and keyboard/DOM controls. |

The CLI adapter contracts use the official [Codex CLI reference](https://developers.openai.com/codex/cli/reference/) and [OpenCode CLI documentation](https://opencode.ai/docs/cli/). Other providers receive accessible worktree image paths; their actual interpretation has not been verified against live paid providers in this run.

## Verification

- Independent Browser lane: 115 files passed, **1,315 tests passed / 3 skipped**, TypeScript and targeted lint passed. Root subsequently built its Electron candidate and verified its ad-hoc signature.
- Independent cross-app lane: **17 tests passed**, including real MCP stdio and Browser WebSocket adapters against synthetic endpoints, actual chat request construction, reviewed-image exclusion and a real isolated CLI fixture. The original project remained unchanged. This does not claim a paid coding model or a native screen was used.
- Hades review UI: **16 DOM tests passed**. A visual fixture uses the actual component and CSS with clearly labeled synthetic RPC data; native rendering/interaction is not accepted from these tests.
- Final focused Hades verification: **69 tests passed** across six affected files. A separate **7-test managed-helper lifecycle suite passed** using actual private fixture processes and stdio, without sockets or native interaction; it covers delayed publication, startup cancellation, stale/malformed discovery and prevention of the standalone auto-launch race.
- Native image helper: actual compiled Swift pixel-mask/diff test passed, including top-left coordinate coverage, exact changed-pixel counts and malformed input rejection.
- Native recorder: **8 direct XCTest cases passed**, including decoding an actual synthetic H.264 movie. Swift 6 source typechecks and integrated Xcode `build-for-testing` passed. A later dispatcher wording assertion was added but not executed as a native test.
- Hades broad desktop attempt after disk recovery: **1,918 / 2,047 tests passed**, 104 / 123 files passed. The remaining 19 files are not accepted: the root sandbox reports 88 loopback `EPERM` errors, a resulting URL error, and explicit tsx pipe denials. The independent review inventories every failed file and distinguishes direct evidence from inferred child-startup restrictions.
- Hades TypeScript check passed. Hades native compilation, Browser packaging, Maus staging and all three strict deep signature checks passed. Signing is local/ad-hoc; Apple Developer signing and notarization remain deferred as requested.

See [independent review and failure inventory](SPATIAL-INTEGRATION-REVIEW.md). Local detailed logs are `/tmp/hades-spatial-desktop-tests-clean.log`, `/tmp/hades-spatial-native-package.log`, `/tmp/hades-spatial-browser-package.log`, and Maus `build/spatial-recordings/`. A signing retry after generated-cache cleanup completed the Hades package; the earlier build log retains that initial disk-related signing failure.

## Remaining acceptance and coverage

1. Launch/relaunch the packaged apps with Computer Use enabled, then exercise the notch, source picker, review/masking and keyboard/focus flow. Automatic Computer Use approval rejected Chrome interaction in this task; Maus interaction was also unavailable in the earlier native attempt. No substitute screenshots or fabricated acceptance were used.
2. Exercise real Screen Recording, Accessibility and microphone consent, point/voice capture, ScreenCaptureKit movie recording, shared-library frame round trip and individually approved AX actions/Stop. No OS security grants were changed automatically.
3. Test live Browser DOM-to-screenshot coordinates and recording/replay on representative web apps, then a real Helm provider change and post-change native/browser recapture. Current source-check, diff and synthetic CLI evidence covers components of this path, not the entire live journey.
4. Rerun the blocked HTTP/pipe test groups in an environment allowed to host their temporary listeners. Root restriction failures must not be presented as a full green suite.
5. Native region-to-movie crop calibration and deterministic original native click attribution remain unsupported. Universal component/source resolution, shared-capture retention management, and SupaMaus enterprise/hosted-tour parity are not asserted by this implementation.

These are visible product and acceptance limits, not claims that the entire SupaMaus feature catalog or every provider is complete.
