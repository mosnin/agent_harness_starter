# Orca package closeout repair

Source follow-up to Hades `d8ebd3033d5202c4e413944a4aa13754286847fa`. The user requested closeout rather than additional feature expansion. This fixes an actual delivery omission: the runtime resolver expects `helm-orca` beside the bundled Node executable, but both native packaging routes omitted that directory.

## Change and verification

Both packaging routes now require and include the pinned Orca artifact tree. The local packager validates a complete inventory, hashes, pin, platform and architecture, rejects symbolic links and unsafe paths, stages into a fresh sibling directory and verifies it before replacing prior output. Failed validation preserves prior output. Local packaging checks the tree again after signing the enclosing app; hashes are not regenerated to conceal altered bytes. Directory replacement is not crash-atomic, and signed Tauri output still needs its final resource check.

`npm run test:helm:orca:package` passes 13 cases: ten author cases and three root review cases. These include the actual Hades artifact validator reading the installed resource layout, rejection after fixture native bytes change, and an interior symlink failing without changing prior output. Fixture native bytes are inert; no native addon, app or provider was executed. The same 13 cases pass under Node 22.22.2 and bundled Node 24.19.0; repeated runs are not extra coverage. Shell syntax checks pass. [Independent review](orca-packaging-review-v1.md) found no additional concrete blocker within this scope.

## Build prerequisites

- The actual Orca checkout remains `bf4e2705046cf9ef9c915929a9646da85717af07`, without installed dependencies. The retained build preflight exits 1 at missing `node_modules/esbuild/package.json`. The full build also requires its locked native modules, agent-browser executable and jsonc-parser assets.
- Node 24 is available at `/Users/preston/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node` (24.19.0), located through the configured workspace dependencies. The default shell Node remains 22.22.2. Use a consistent supported build/bundled runtime and validate the real native ABI before release; fixture inventory checks do not prove it.
- The Helm checkout is the clean pinned `89bac15fcea8f7fb90d50c6d4cf457b25673a7b5`. Bun 1.3.14 is absent. An ordinary attempt to read the official Bun release API failed DNS resolution; no download or install occurred. Existing Helm UI artifacts still identify older `a96be40a1dcb7e05a7acd38de99c6ec0376ecc74` without complete provenance and are correctly refused.
- A no-install Helm build can still fetch models.dev. Offline generation needs an explicit retained `MODELS_DEV_API_JSON` snapshot; no substitute snapshot was invented.

No native build, app installation, provider deployment, live OAuth journey or actual Orca execution is accepted. No user data or existing app was deleted to reclaim disk. The full goal remains active under [the closeout plan](../CLOSEOUT.md).

## Node 24 regression

Using the exact bundled Node 24.19.0 executable, the existing Work/Helm gate passed 391/391 cases in 37 files and the Plugins gate passed 303/303 in 21 files, sequentially. Their 11 shared routing cases leave 683 distinct cases. Adding the 13 packaging cases gives 696 distinct source cases. Repeated Node 22/24 and npm-entry-point packaging runs are not added again. These are source fixtures, including owned-host process/Git/SQLite tests, not native provider or app execution. No full native build was attempted.
