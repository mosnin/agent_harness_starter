# Helm fork packaging provenance

Desktop packaging now requires schema2 Helm provenance: exact reviewed revision/version/Bun pin, clean source state at build, a SHA256 inventory of all tracked and nonignored untracked source inputs, the complete UI file inventory and runtime hash. Internal source symlinks are bound to their targets; external symlinks are refused. Source stability is checked before/after compilation and asset staging. No dependencies are installed by this guard.

`node scripts/check-helm-provenance.mjs` verifies distribution assets offline without a checkout. Set `HADES_HELM_OPENCODE_SOURCE` when the checkout is available to additionally refuse any local source drift. The guard runs in the macOS bundle script, Tauri beforeBuildCommand and the actual native step of packageDesktop. Dry-run package planning remains distinct from native packaging.

Code-signing restamping first checks the original verified build, copied UI and copied provenance. For the supported thin little-endian64-bit Mach-O runtime, it compares executable payloads while excluding only signature bytes and LINKEDIT size bookkeeping. Other binaries must remain byte-identical. Unsupported signing layouts refuse stamping. Signing identity/native acceptance is a separate gate.

Current dist assets were built from a96be40 and carry the old schema. Branding is now locally committed in the actual fork at `89bac15fcea8f7fb90d50c6d4cf457b25673a7b5`, and third_party/helm-opencode.json pins it. The checker correctly refuses the old assets. Required action: obtain the locked prerequisites on an authorized build host and run `HADES_HELM_REQUIRE_PIN=1 npm run helm:build -- --source /path/to/helm-opencode` with Bun1.3.14. No actual fork/native rebuild or installation was performed in this task.

Source branding adds Helm to sidebar getting-started and Windows reopen-app copy. OpenCode Zen/Go provider branding, config/package/protocol identifiers, backend WSL engine references and attribution remain upstream. Tests load the actual fork helper and dictionary through available Hades esbuild; they do not constitute a Bun application build.

Evidence: 13 Node tests (branding/provenance, including dirty/untracked source, old schema, asset/runtime drift, offline verification and signing payload changes) pass; 20 package orchestration tests pass with explicit injected provenance fixture. Actual stale dist check returns refusal. JavaScript and shell syntax checks passed.
