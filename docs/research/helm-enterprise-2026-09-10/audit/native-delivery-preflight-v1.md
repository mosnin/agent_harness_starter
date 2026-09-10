# Native delivery preflight

The user asked to wrap up. Delivery was prioritized over further accounting expansion. The previous status-only reply was no progress; this turn revalidated local prerequisites and ran the actual offline native build.

At Hades source38c4a30, Xcode selection is /Users/preston/Downloads/Xcode.app/Contents/Developer and Swift is6.2.1, arm64. Free disk was3.1GiB before build and2.9GiB during compilation. Existing native/Helm binaries were inspected as files only; their presence was not accepted as current build provenance.

`node scripts/package-helm-orca.mjs --check` exited1 because dist/helm-orca is absent. `node scripts/check-helm-provenance.mjs` exited1 because the Helm assets lack complete current source/UI provenance.

`cargo build --offline --manifest-path src-tauri/Cargo.toml --features gui -j 1` compiled cached dependencies, then exited101 in the native build script: resource path ../dist/helm-orca does not exist. No new native app was built or installed. The resource gate was not removed or substituted. See ../evidence/native-delivery-preflight-v1/cargo-offline-build.rawlog.

Bounded independent read-only prerequisite audit:
- Bun1.3.14 is unavailable from command lookup and the checked ~/.bun/bin and /opt/homebrew/bin locations. No alternate cached executable was documented in the inspected Helm checkout.
- Helm source is89bac15 on helm-integration. Existing packages/app/dist and packages/opencode/dist/opencode-darwin-arm64/bin/opencode exist, but Hades provenance names olda96be40 and lacks current schema/Bun metadata. They are not an accepted rebuild of the pinned source.
- The current shipping Orca foundation bf4e270 has no node_modules. The separate integration source54ad5507 has focused source acceptance only, not full pinned dependency/build/runtime acceptance.

Required delivery inputs are Bun1.3.14, locked Orca build/native dependencies, then reproducible Helm/Orca staging before the native build can finish. Do not bypass earlier download/native-control/remote-write denials through alternate tools. Apple Developer enrollment is excluded by the user and is not this blocker. No installation, network download, app control or remote write was performed.

Full enterprise acceptance remains open. These concrete delivery blockers do not establish the live seven account workflows, coding/browser/Maus/passkey acceptance, long-run comparisons or accounting/policy gates.
