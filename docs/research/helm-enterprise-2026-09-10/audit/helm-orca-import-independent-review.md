# Orca provenance and materialization: independent source review

Reviewed 2026-09-10 in the local Hades checkout. Scope is the actual `HelmOrcaService.prepareImport` authority checks and `helm-orca-import.ts` filesystem/Git implementation. The reviewer authored only the new `src/desktop/__tests__/helm-orca-import-review.test.ts` and this report; the implementation owner repaired the defect below.

## Finding and repair

**Resolved — destination could be inside the source repository.** The original materializer rejected the source root itself and worker descendants, but accepted `source/import` and `source/.git/import`. Both actual temporary-Git tests resolved successfully instead of rejecting: they created a detached worktree where the no-source-file-effect boundary requires refusal. This is a reusable-helper defect even when the current caller normally chooses a private destination.

- Initial independent run: 1 failed, 6 passed; `/tmp/helm-orca-import-review-red.log`.
- Expanded source/Git-metadata destination run: 2 failed, 6 passed; `/tmp/helm-orca-import-review-red-v2.log`.
- Owner repair at `helm-orca-import.ts:68` rejects the source, its descendants, source common Git directory and descendants, and worker root/descendants before effects. Canonical-parent and nonexistent-destination checks remain.
- Independent rerun after repair: **16/16 passed** (8 independent cases + 8 existing author cases), `/tmp/helm-orca-import-independent-green.log`, 5.68 seconds.

## Independent cases

| Challenge | Result |
| --- | --- |
| Destination inside source or its Git metadata | Refuses before creating destination after repair |
| Source directory replaced with byte-identical copied Git metadata and HEAD | Dispatch-time source identity rejects replacement |
| Worker directory replaced after descriptor creation | Descriptor identity rejects replacement |
| Wrong worker base SHA; later live observation contradicts earlier exited observation | Both refuse provenance |
| Empty commit changes worker HEAD without changing file bytes | Retained descriptor refuses drift |
| Source staged and dirty bytes; different worker staged and working bytes | Materialization preserves both raw Git index files and source/worker contents |
| Deleted nested directory, 65,536-byte binary addition, two literal symlinks to the same absent outside target | Destination preserves deletion, exact binary bytes and literal symlink targets |
| Assume-unchanged index state; destination parent redirected through symlink | Both refuse before destination writes |

Tests execute actual temporary Git repositories, linked worktrees, file operations, SQLite-backed Orca intent storage and materialization. Only the runtime connection is modeled; worker identity/base/observation messages are explicitly varied. No worker executable, provider, listener, native app or external repository is launched or modified.

## Frozen evidence

| File | SHA-256 |
| --- | --- |
| `src/desktop/core/helm-orca-import.ts` | `150e0038a10c93e6af957863dea2ebf81b1803fc9514f5d8ef9ab07c961aee01` |
| `src/desktop/core/helm-orca-service.ts` | `8d3f73a32142d3d29baf5be880b02277c323d652045c23b99ea3744ac8727e16` |
| `src/desktop/__tests__/helm-orca-import-review.test.ts` | `5c9e683e9e3e43ca2044db8fccba4cc955d2681ac584474f11012d55f711e8b1` |

Reproduction: `./node_modules/.bin/vitest run src/desktop/__tests__/helm-orca-import-review.test.ts src/desktop/__tests__/helm-orca-import.test.ts --maxWorkers=1`.

No further material blocker was reproduced in this bounded helper/provenance review. This does not independently accept the parent Work scheduler, durable destination claim, source apply, checks, completion/usage accounting, or actual Orca runtime protocol. Git worktree registration intentionally changes Git metadata; preserving source files and indexes does not mean every repository metadata byte remains unchanged. Snapshot comparisons detect observed drift, not an OS lock against unrelated editors or a proof that an exited process has no surviving descendants. Caller-owned durable claims and subsequent verification remain required, and native/provider acceptance remains open.
