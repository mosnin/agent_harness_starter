# Spatial cross-app integration review — 2026-09-10

Scope: independent Hades adapter/Workbench acceptance against the Browser spatial contract at `47a42324d478d3e746022b0af031bd5b3dbae368` and current Maus Swift protocol source. Hades baseline is `420e330a48ce6ecf9a840de8801a0cc099f86387` plus the root agent's uncommitted spatial implementation. This lane changed only this report and `src/desktop/__tests__/spatial-cross-app.test.ts`. No implementation was edited, app installed, user screen observed, permissions changed or paid provider contacted.

## Tested path

| Boundary | Evidence | Limit |
|---|---|---|
| Maus → MCP → Hades | Real stdio child, actual `connectMcp` and `MausCompanion`; strict point/latest argument checks; native-shaped `structuredContent.captures`; text and PNG separated correctly | Native response is a synthetic fixture, not an installed Maus capture |
| Refusal/failure | Text-only no-capture refusal, MCP error, unsupported image MIME, missing tool, missing bundled helper all reject; hanging real child cancelled after observed dispatch | Does not exercise macOS permission UI or native chooser |
| Review → provider → Helm | Real MCP capture becomes session-owned packet; unreviewed handoff rejected; reviewed image reaches actual chat-turn request construction (provider stub); immutable idempotent draft starts a real isolated CLI fixture with image file; source remains unchanged; duplicate start rejected | Coding CLI is a synthetic local executable, not Codex/provider work; task ends needs_review, not applied/verified |
| Quota recovery | Current unshared revision removes capture and summary files; stale revision, another session and shared/handoff captures are refused | No shared evidence is deleted |
| Exclusion/scope | Excluded image and screen text absent from actual chat request; another session cannot read the packet | Region pixel redaction has separate native-helper tests |
| Browser → Hades | Actual `HadesBrowserClient` over real loopback WebSocket with synthetic paired server; returned image dimensions and geometry retained; local source hint labeled existing-file/component-unverified | Does not execute Browser Electron page runtime or demonstrate live coordinate alignment |
| Browser malformed response | Wrong ref, missing workspace, invalid screenshot metadata fail closed and create no packet | Browser DOM freshness/policy itself covered in Browser repository tests |
| Recording/replay lifecycle transport | Start/status/stop flow retains one registered run through actual client; preview uses original workspace and duplicate request opens once | Synthetic server acknowledges; no human interaction or sensitive-action approval tested here |
| Compare | Native diff summary correlates before/after IDs via real MCP; Browser structural gap change detected after explicitly excluding images | No pixel compare in this lane; no inference that changed appearance means correct behavior |
| Native preview refusal | Actual Workbench path refuses Maus handoff without originating Browser space before Browser dispatch | Source-check receipt is explicitly stubbed to isolate this provenance guard; not full source-check acceptance |

Native schema checked read-only in `HadesMausKit/Sources/HMServer/MCP/HMToolArguments.swift`: get_context uses numeric count/maxVisionTokens and string-array include; pointing uses string question, numeric timeoutMs, boolean allowVoice. `HMToolDispatcher.swift` returns captures with captureId/createdAt and diff fields beforeCaptureId, afterCaptureId, windowsCompared, windowsRefused, elementChanges, layoutFindings, unchanged. Tests exercise these shapes through the real TypeScript adapter, not a mocked capture method.

## Findings repaired by the root during review

1. Browser capture initially checked tab/snapshot only. Root added exact returned ref, trusted workspace identity, freshness, geometry and screenshot shape checks. Regression tests reject all three malformed fixture variants.
2. Native spatial handoffs carried placeholder notebook workspace `native`. Root added an explicit no-originating-Browser-space refusal before preview dispatch. A native capture now points users toward recapturing their native app for comparison rather than pretending it has Browser provenance.

3. `MausCompanion.close()` initially left active configured-MCP requests running and allowed later configured calls. Root now tracks linked per-call abort controllers, aborts all on close and rejects new calls after closure. A real hanging stdio fixture reproduced the failure, then passed the shutdown/late-dispatch regression.
4. Native comparison initially used packet digests for `imageChanged`, so different packet IDs alone appeared to mean changed pixels. Root now uses decoded pixel-comparison results and returns null when no image pair is available. The regression injects an explicit identical-pixel processor fixture and verifies both false-with-evidence and null-without-images; it does not claim native pixel processing here.

## Packaging and lifecycle inspection

The packaged Node executable is `Contents/Resources/node`; the companion's sibling `HadesMaus.app` lookup matches `scripts/bundle-maus.mjs`. That script validates regular executables, bundle identity and signing before staged replacement. Configured enabled MCP bridges remain a separate route and no missing helper is silently installed. Native `--hades-embedded` uses accessory mode, omits bot loading, observes SIGTERM and watches its parent. Availability is a filesystem/status check, not a live capture or permission receipt.

The native startup orphan race reported during review is now repaired in `apps/HadesMaus/Sources/AppDelegate.swift` (read-only source verification): embedded launch requires an integer `HADES_MAUS_PARENT > 1` matching `getppid()` before runtime startup; the common-mode watcher compares the same expected PID thereafter. Shutdown cancels and awaits the owned startup Task before stopping the host. The root reports the integrated Xcode build passed; this lane verified source only and did not simulate a packaged parent crash.

## Current acceptance

`npx vitest run src/desktop/__tests__/spatial-cross-app.test.ts`: **17 passed**. `npx tsc --noEmit --incremental false`: passed on the current shared working tree. Tests own temporary files, stdio subprocesses and loopback WebSocket servers and close them after use.

No additional concrete TypeScript adapter or source lifecycle blocker was found after those repairs. This is not acceptance of the complete native user journey. Still required: packaged helper availability/launch, explicit pointing capture with real permissions, review/redaction usability, live Browser element/screenshot coordinates, human recording→stop→review→replay, actual provider image interpretation when authorized, source apply/check receipt, and native preview/result recapture. The source-check and preview branches have component tests here; they are not one continuous live end-to-end run.

## Broad desktop run invalidated by disk exhaustion

The subsequent broad desktop run (parent exec session6993, Node22.22.2) exited1 with direct disk-exhaustion evidence. It must not be treated as either a successful full-suite receipt or a clean source-regression verdict. `/tmp/hades-spatial-desktop-tests.log` reports esbuild failing to write the synthetic sidecar at line87, then 15 collection failures sharing `Error: ENOSPC: no space left on device, write` at lines273–288. Helm preview and inference collection also fail opening Vitest SSR temporary files at lines291–296. The reporter reached only `[3/177]`; there is no complete per-failure diagnostic inventory or final test-count summary.

Other suites show5-second timeouts and later setup failures; the spatial cross-app lane has one broad-run failure despite its17/17 isolated pass above. Those secondary failures cannot be individually attributed from this incomplete log. No Node-version or sandbox error is evidenced. No implementation regression was established by this corrupted broad run; rerun after adequate free space with bounded worker count is required before making a full-suite conclusion.

Retained broad-log SHA256: `26bd360d95e2d1833ce2bee1b375e368ac223ba4688342b0aef8c421567a9f91`. Initial observed free space117MiB; parent cleanup raised it to263MiB and further build-cache cleanup was planned. This reviewer did not delete caches or launch another broad suite.

A clean low-worker retry later showed Helm timeouts again; its failure stacks were not yet available at this checkpoint. The specifically requested isolated reproduction `npx vitest run src/desktop/__tests__/workbench-helm.test.ts -t 'declining Helm delegation'` passed (1passed/5skipped, test287ms, total637ms) on Node22.22.2 at `/Users/preston/.local/bin/node`; log `/tmp/hades-helm-decline-repro.log`. Therefore that individual source regression was not reproduced. The clean broad retry must be classified separately from the earlier ENOSPC run; launch configuration and final error details remain to be reconciled, without automatically blaming disk or environment.

A second narrow reproduction matched the parent's exact launch style and explicit environment: `HADES_SPATIAL_TEST_HELPER=/tmp/hades-spatial-image-helper ./node_modules/.bin/vitest run src/desktop/__tests__/workbench-helm.test.ts -t 'declining Helm delegation' --maxWorkers=2`. It also passed (1passed/5skipped, test298ms; `/tmp/hades-helm-decline-exact-repro.log`). This rules out that explicit helper variable and direct Vitest shim as sufficient causes. Broad failures cluster around real HTTP/WebSocket fixtures; the cross-app suite's only broad failure is its real Browser WebSocket test, while its MCP/CLI cases proceed. A network/listen-context difference is a hypothesis, not an established cause. Concurrent build writes do not directly explain this Helm fixture, which imports source and creates its own private CLI executable. The broad run was still pending final diagnostic stacks when this checkpoint was written.


## Final clean broad-run audit: restricted listening environment

The retry completed: **104/123 files passed; 1918/2047 tests passed; 19 files /129 tests failed;89 unhandled errors** in266.68seconds. Root independently observed `node:http` immediately fail `listen EPERM: operation not permitted 127.0.0.1`. This establishes a restriction in that execution context; no attempt was made to bypass it or rerun network tests after identification. Unlike the first run, this final log contains no ENOSPC. Log SHA256: `c01d62dc1a7aa76be33e6872205815b99d85f3045ee7da6ed7ca1216c734edb5` (`/tmp/hades-spatial-desktop-tests-clean.log`,2777lines).

Every failed file is accounted for below. Counts are failed tests, totaling129.

| File under src/desktop/__tests__ | Failed | Failure chain |
|---|---:|---|
| browser-runtime-server.test.ts |8| Direct loopback listen EPERM shared failure block (lines217–229) |
| team-chat.test.ts |4| Same direct loopback listen EPERM block |
| credential-pool.test.ts |1| HTTP fixture times out; file-attributed uncaught listen EPERM |
| desktop-additions.test.ts |2| Ollama HTTP fixture setup times out; file-attributed listen EPERM |
| hades-browser-client.test.ts |12| Real WebSocket fixture setup times out;12 attributed listen EPERM errors |
| helm-code-service.test.ts |16| Synthetic OpenCode backend exits before startup. Its fixture immediately binds127.0.0.1; consistent with the confirmed restriction. Child stderr is sanitized from these failure stacks, so the exact child syscall is inferred from fixture source, not directly preserved |
| native-schedule.test.ts |1| HTTP-backed Workbench fixture times out; attributed listen EPERM |
| schedule-wiring.test.ts |1| Real schedule/HTTP fixture times out10seconds; attributed listen EPERM |
| spatial-cross-app.test.ts |1| Only the real Browser WebSocket test times out; attributed listen EPERM. Other16 cases proceed |
| state-roundtrip.test.ts |2| Child tsx startup explicitly fails listen EPERM on its Unix `.pipe` socket (lines568–633); state logic does not get exercised |
| webhook-service.test.ts |9| Listener cannot start; `running` is false and subscription URL remains empty. Assertions/Invalid URL errors follow that failed listener. Source catches listen error and reports it in status; no source effect regression is demonstrated |
| workbench-browser.test.ts |27| HTTP/WebSocket fixtures time out;27 attributed listen EPERM errors |
| workbench-delegation.test.ts |4| HTTP fixture timeouts;4 attributed listen EPERM errors |
| workbench-durable-work.test.ts |2| HTTP fixture timeouts;2 attributed listen EPERM errors |
| workbench-helm.test.ts |6| HTTP fixture timeouts;6 attributed listen EPERM errors. Requested isolated declining-delegation case passed twice before restriction identification |
| workbench-hooks.test.ts |6| HTTP fixture timeouts;6 attributed listen EPERM errors |
| workbench-maintenance.test.ts |3| Empty webhook URL plus2 HTTP setup timeouts; listen EPERM and resulting Invalid URL recorded |
| workbench-service.test.ts |21| HTTP-backed cases time out;21 attributed listen EPERM errors |
| workbench-webhook.test.ts |3| Listener/HTTP admission fixtures blocked;3 attributed errors |

The89 unhandled errors comprise88 loopback listen EPERM errors and one downstream Invalid URL rejection. The two tsx pipe EPERM failures are captured directly in their test failures instead. The native image-helper file is **not** among the19 failed files; the command supplied `HADES_SPATIAL_TEST_HELPER=/tmp/hades-spatial-image-helper`, that file exists, and the final summary reports no skipped tests. There is no native image-helper regression in this log.

No independent source-regression failure remains identified outside these listening-dependent chains. This does **not** prove the16 sanitized OpenCode child exits or every blocked behavior would pass in a permitted environment; it identifies the evidence boundary without declaring a false full-suite pass. The earlier17/17 independent cross-app receipt remains valid for its explicitly scoped fixture environment. Final broad acceptance remains blocked by the root context's listen restriction, not replaced by that narrow receipt. No additional network test was started after the restriction was established.


## Final managed-Maus startup review (no listening/network)

Added `src/desktop/__tests__/spatial-maus-lifecycle.test.ts`: **7/7 passed**, plus `tsc --noEmit --incremental false` passed. Fixtures are actual temporary executable app/bridge processes, communicating only through private files and stdin/stdout. No TCP, Unix listening socket, native UI, HOME override or real runtime discovery directory was used. Cleanup closes the companion and verifies owned helper PIDs have exited before removing private fixture directories.

The tests prove: delayed port publication does not dispatch the bridge early; bridge receives `--no-launch --runtime-directory <private fixture>` and returns valid MCP capture context; an existing publication refuses both app and bridge startup; cancellation during startup cannot dispatch a bridge after late publication; close cancels startup and refuses later calls; child exit before publication fails; invalid numeric publication fails; and a dangling discovery symlink refuses before spawning. Seven test cases group these assertions.

Independent source review matched the native ArgumentParser options (`launch` with prefixedNo inversion and runtimeDirectory). Hades owns startup, waits at most20seconds for a bounded regular valid port file, and the bridge cannot auto-launch an older standalone app. This review found `existsSync` ignored dangling symlinks; root replaced it with lstat and treats non-ENOENT errors as an existing publication. The new regression failed before that repair and passed after it. Readiness here means discovery publication followed by real stdio initialization against the fixture; it is not a native authenticated health or capture receipt. Packaged sidecar rebundling and actual native readiness remain root-owned.
