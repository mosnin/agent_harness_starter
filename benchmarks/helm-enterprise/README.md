# Helm enterprise benchmark v1

Frozen local fixtures for PROGRAM G04/G19, not matched comparison results.
Eight coding tasks and sixteen orchestration/general work scenarios each require
three trials. Unexecuted cases remain unavailable. The separate requested Codex
comparison task remains blocked; local fixture construction does not substitute
for it.

## Run without installation

    node scripts/benchmark-helm.mjs list
    node scripts/benchmark-helm.mjs prepare quoted-csv '{"trial":1}'
    node scripts/benchmark-helm.mjs grade /tmp/helm-benchmark-.../trial.json /tmp/helm-benchmark-.../workspace '{"harness":"manual","candidateRevision":"COMMIT"}'
    node --test scripts/__tests__/benchmark-helm.test.mjs

Prepare creates an owned temporary directory. Give the harness only workspace/,
including prompt and broken source, never oracle/reference/catalog. Only
supplied code files may change: prompt edits, added/missing files, symlinks and
files above 1 MiB fail integrity. No provider, network, listener, dependency
installation or scenario command is invoked by the CLI. Remove owned trial
directories explicitly after retaining receipts.

Grade with "-" instead of candidate returns unavailable (exit 2). Failed exits
1, passed exits 0. Receipts include source hashes, trial ID/number, caller-supplied
model/harness/revision/usage/interventions, grading elapsed time and separately
supplied task elapsed time. Missing metrics remain null, not zero. Passing local
candidates retain productWin:false. Reference trials MUST supply reference:true
and are synthetic-oracle-calibration, not Hades/provider success. Metrics are
caller reported, not verified provider accounting. Prepare each trial separately.

## Integrity and limits

FROZEN.json hashes every prompt, original source, oracle, reference, runner,
catalog and this README; its digest is pinned in the grader. Verify runs before
and after grading. A fixture revision needs a new explicitly versioned freeze,
never a silent result rebaseline. Candidate workspace must remain unchanged
during grading.

Expected results stay in the parent grader. Children receive inputs only.
Early process exit, malformed output, input mutation, timeout and oversized
output cannot pass. Each case has a fresh child, scrubbed environment, two-second
timeout and bounded stdout. Node permission mode denies filesystem writes,
child processes and addons. This is NOT a hostile-code sandbox: Node 22 permission
mode does not block networking. Run only trusted candidate source; untrusted
external submissions need a separately provisioned offline OS sandbox. Fixtures
use no network, credentials or external data. No sandbox acceptance is claimed.

## Scenario coverage and comparison

scenarios.json points to actual DurableWork source and exact named tests:
artifact dependency gating, reconciliation, rolling admission, ownership,
stale evidence, limits, private storage, malformed DAGs, profile isolation,
cross-agent dependencies, session isolation, hostile artifacts, steering races,
transitive invalidation, late callbacks and worker ownership. These are existing
control tests, not provider intelligence results, and remain definitions until
executed on a pinned revision. This CLI never runs scenario commands.

Matched comparisons must retain all 24 cases and all three trials, including
failures/unavailable harnesses. Fix task, model/version, budget, tools and approval
policy across comparable harnesses; disclose unsupported differences. Report
per-case receipts, unavailable counts, task elapsed time, usage, interventions
and recovery. Never rank products from synthetic calibration.
