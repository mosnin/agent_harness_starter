# Company OS framework in Hades

> Current addendum: missing/corrupt bundles now fail closed without crashing Hades, and 19 framework tests cover availability and recovery. The actual npm pack archive was parsed into the same pinned bundle; npm-archive-receipt.json records this. ACCEPTANCE_V2.md is the current integrated evidence index; earlier counts below are historical.

Source integration, not native or remote-release acceptance. Canonical source is `/Users/preston/companyos-release`, origin `mosnin/companyos`, clean branch `codex/npm-distribution`, revision `5b374ba2066332c44f74eafddab4f8f575715ba3`. Package `@mosnin/companyos` version0.6.0 declares Node>=20 and UNLICENSED; no blanket open-source license is asserted. This is the framework, not the CompanyOS SaaS account or the Agentic Research repository.

`third_party/company-os/bundle.json` contains all688 distribution files as text data, not an executable installation. Its9,167,400bytes hash to `bab686685a36437967e3445934c4af983085a82962c84d63ae17adcf0244d59d`. `manifest.json` pins the source/version/digest. Vendoring validates the canonical manifest, source cleanliness and release identity; no npm/Bun installation, lifecycle hooks or framework scripts run. Copy BOTH resource files into desktop resources, retaining their names and use the host-resolved immutable resource path. Never trust renderer-provided bundle/hash locations.

## Host API

`new CompanyOsService(dataDirectory, bundledFile, {sha256,version,revision}, optionalFetcher)`; first three arguments mandatory. The optional fetcher is for deterministic fixtures; production defaults to fetch.

- `status(profile)` returns enabled, version, revision, sha256, integrity, latest state, autoUpdate, rollbackAvailable and explicitly instructions-only runtime/scheduling disabled.
- `setEnabled(profile, boolean)` and `setAutoUpdate(profile, boolean)` persist independent profile preferences; disabled by default. No check runs until host calls it.
- `context(profile,{skill?,maxBytes?})` loads complete selected SKILL.md only, default company-os/company-os/SKILL.md. Disabled refuses. Default24KB,max64KB; oversize refuses rather than silently truncating mandatory instructions. Root should resolve `/company-os` explicitly and attach this content with its authority qualifier. Select additional skills with catalog rather than loading the whole distribution.
- `catalog(profile)` returns available skill paths and sizes, no script execution.
- `checkUpdates(profile,{apply?,signal?})` checks fixed npm registry; automatic activation only when autoUpdate remains enabled, or apply:true is a host-approved explicit action. Root owns startup/periodic cadence and must stop it on close. Check-only returns available without switching. Status distinguishes not_checked/current/available/incompatible/updated/error/cancelled.
- `rollback(expectedActiveSha)` validates retained prior content and atomically switches using a current-version fence. Release selection is global within the service; disclose that updating it affects all enabled profiles.
- `activateVerified(file,{sha256,version,revision},expectedActiveSha)` is a **trusted host-only** primitive used by the updater. Do not expose it as a raw renderer or agent RPC.
- `close()` revokes pending update and closes storage. Existing active bytes remain available offline on next launch.

## Update trust and limits

The exact npm package metadata is downloaded from https://registry.npmjs.org/@mosnin%2fcompanyos, redirects refused. The metadata-selected exact version's gitHead, package name, semver and sha512 archive integrity are required. Archive location is restricted to the expected npm path. Every canonical distribution file's sha256 and length are checked. HTTPS registry metadata is the trust source; this does not establish an independently verified npm provenance signature or newest deployment. Only same-major stable versions are accepted automatically. No scripts execute and no framework content changes host permissions, cancellation or scheduling.

Limits: metadata2MiB, compressed archive16MiB, expanded tar32MiB, bundle20MiB, inventory2000files/16MiBtext, retained10releases; context64KB. Unsupported tar links/PAX/long-name entries fail closed. Download timeout20s and AbortSignal propagate. SQLite transactional activation and stale-current guard preserve previous selection. An interrupted update may leave an unreferenced content-addressed file; it is never selected automatically. Rollback is explicit; a later auto-check can discover the newer version again, so disable auto-update to pin the rollback.

## Evidence and remaining gates

Nine deterministic tests pass, including real bundled688-file integrity, profile isolation, bounded context, tampering, stale update rejection, restart/rollback, fixed registry identity, cancellation, incompatible releases and synthetic npm archive activation. Production code typecheck passed before final test additions; root should run final types with integration. No listener, native app, registry call, provider or install script was run.

The vendor script uses standard Node builtins and produces runtime-independent JSON. Canonical npm metadata exposes a Node CLI and Node>=20; Bun compatibility is designed via the same data artifact, but actual Bun CLI/install execution is unverified. Hades itself uses Node SQLite; do not claim its service is Bun-runtime tested. Native toggle, slash invocation, resources packaging, actual npm archive format compatibility and authenticated release/provenance acceptance remain root gates. Framework runtime/controllers and scheduling stay feature-off until their own canonical acceptance gates pass.
