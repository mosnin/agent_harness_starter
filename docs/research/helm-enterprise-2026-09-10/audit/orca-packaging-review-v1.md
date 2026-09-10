# Orca packaging source review v1

Read-only review of the bounded packaging fix. No new concrete correctness blocker found in the reviewed staging/validation/wiring scope.

The helper rejects noncanonical/symlink paths, incomplete or extra inventory, mismatched pin/platform/architecture and altered bytes before replacing prior output. It validates both staged and source trees again before publication. The shell native path stages Resources/helm-orca and checks it after outer signing; Tauri maps the same resource directory and preflights it before compilation. Prior-output replacement is intentionally not crash-atomic; the documentation explicitly preserves the backup/recovery limitation.

The retained `/private/tmp/hades-orca-package-review.log` reports **13/13 passing tests**, including actual HelmOrcaRuntime artifact-validator consumption, post-stage tamper refusal and interior symlink/prior-output preservation. I inspected source and retained results; I did not rerun tests, build a native package, load native addons or launch a runtime. Inert native fixture bytes establish inventory/staging behavior, not ABI compatibility.

Release gates remain: actual Orca dependencies absent; approved bundled Node 24.19.0 is available at `/Users/preston/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`, with actual upstream dependency/native ABI compatibility still unverified; Bun 1.3.14 absent; Helm offline generation requires a retained models snapshot. Native dependency loading, final signed Tauri resource integrity, actual daemon/provider execution and installed application acceptance remain unverified. No signature/authenticity claim follows from locally generated hashes.

## Reviewed hashes

- `scripts/package-helm-orca.mjs`: `3007cff437e8ff5193acb2e285444f32b1d6af7324c7bd80fec10575c57a8813`
- `scripts/package-helm-orca.test.mjs`: `6a3b838627e325b411a789cc778a0b5e1fd0a87d6db54f00bb473e7d0b982244`
- `scripts/package-helm-orca-review.test.mjs`: `15680079c50d015b6b86bcb5700135cc1bec9f3b92d63956385b219af6add846`
- `script/build_and_run.sh`: `1fd474dad6bfbf7361143edc199882e0420eadded8cc3de305748aa6455117df`
- `src-tauri/tauri.conf.json`: `fd81f1ef5e82815e47501328d22c60c98ab17ffeae16c6bc2d7a6c319dc15440`
- `docs/HELM.md`: `ead0b3ba59568767613fa908f63b10559034a47c8901305cedda33b359841af0`

Node 24 follow-up: root reports the same 13 packaging tests passed under the approved bundled Node 24.19.0 (`/private/tmp/hades-orca-package-node24.log`). This removes the missing-required-major prerequisite; it does not establish actual Orca native addon loading.

Available-runtime regression: using that exact Node 24 executable, Work/Helm passed 391/391 across 37 files (exit 0, 114.43s), then Plugins passed 303/303 across 21 files (exit 0). Logs: `/private/tmp/hades-closeout-node24-work.log` and `/private/tmp/hades-closeout-node24-plugins.log`. Gates were invoked sequentially with their existing runner settings. These are Hades source regressions with fixture transports, not an actual Orca build/native ABI acceptance.
