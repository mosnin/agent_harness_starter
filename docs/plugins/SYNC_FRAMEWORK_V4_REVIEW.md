# Sync and framework v4 independent review

2026-09-10. Bounded source and offline fixture review. No native app control, listeners, network/provider operations, installation or deployment were performed. The reviewer changed only the new independent stream test and this report; implementation belongs to the respective authors.

## Streaming fallback

The independent review reproduced an immediate duplicate sync: a successfully opened stream whose initial data catch-up failed caused the error handler to call the data API again in the same background job. Initial evidence: `/tmp/ecosystem-stream-fallback-review-red.log` (one failed, one passed); extended evidence `/tmp/ecosystem-stream-fallback-review-red-v2.log` (one failed, two passed).

The author repaired shared catch-up/fallback attempt accounting and a 30-second failed-sync cooldown. Independent final run: **3/3 passed**, `/tmp/ecosystem-stream-fallback-review-green.log`, using actual service/store/stream code with injected HTTPS fetch responses and temporary SQLite storage. The seeded fixture is adapted from the author suite; the three negative/lifecycle cases were independently authored.

The cases verify:

- One failed catch-up attempt, no extra attempt at 15 seconds, and exactly one new attempt at 30 seconds.
- Pause while fallback is pending prevents late cache/cursor replacement and further background dispatch.
- Injected 60-second stream-lifetime expiration removes the live watch and permits exactly one catch-up on reconnection, with duplicate tick calls suppressed.

The rotation oracle was corrected during review: reader cancellation can complete as normal EOF or a timeout error. A normal EOF does not require an immediate fallback request. The final oracle permits either termination path, bounds its data attempts, and requires exactly one catch-up on the actual reconnect. This is not a claim that a real provider connection stayed healthy for 60 seconds.

Reviewed service SHA-256: `a1dbc0ec8afc668ed3532d58ec4383481824b5b175877b7f6a7998c1e2d89653`.

Independent test `src/desktop/__tests__/ecosystem-stream-fallback-review.test.ts` SHA-256: `f894336972c5266e354ed665efdc325beacb30e3d9d5557d7a51941f285a80ed`.

## Company OS resource reads

Read-only review found no concrete path, cursor, version, disabled-state or authority defect in the frozen resource API. Each read revalidates the retained bundle and calling profile enablement. Catalogs expose retained paths only; relative references resolve within validated bundle namespaces and must name an actual retained file. Resource cursors bind the profile, release digest, canonical target path and file hash. UTF-8 chunks avoid partial continuation bytes and explicitly report whether the source is complete. Scripts are returned as data, without extraction or execution.

The tool preserves skill catalog reads and complete skill reads up to 64,000 bytes, and rechecks cancellation and enablement before returning. The inspected AgentLoop forwards `result.output` intact into its tool result; no hidden fixed-length output truncation was found on that path. Model context limits and native display remain separate concerns.

Frozen hashes match the independently inspected source:

| File | SHA-256 |
|---|---|
| `src/desktop/core/company-os.ts` | `bc8c31ba9b282fe08fa462fdb7088f09641ce6d8d86efe5dde30fedb3c4c73c3` |
| `src/desktop/core/company-os-tools.ts` | `bb85ae83ad19135c5e496cdd62e7670e7a3271c9a03cc54715cda14644042fb7` |

The author reports 51/51 tests across three files, including 32 new resource cases. After the combined 303-case gate passed, TypeScript identified two optional-validator calls in the new tests. The author changed those calls to optional chaining while retaining the expected-string assertions, so a missing validator still fails. The final resource test SHA-256 is `d5f5123978de21fc279c6ed84dafc402464d6892d60aa7d07913c6877e91b015`; `2645742686930ba55b1aa99ce18951d2316a207548c77f94e15a2e880be23930` is historical. The author reran the 32 resource cases successfully in `/tmp/hades-company-os-resources-type-repair.log`. Updated author receipt `/tmp/hades-company-os-resources-receipt.json` is reported at SHA-256 `74099dfc03d9288373cd4d733689a4c8767870ac25ebcf6384e83b7d3165f640`, retaining old/new test identities and the prior receipt hash. Both reviewed production hashes above are unchanged; this test-only correction requires no production re-review. These are author-run evidence, not independently rerun tests in this resource review. No redundant independent suite was added absent a concrete uncovered defect.

## Disposition and limits

Accepted for the reviewed source and offline fixture boundaries. No further concrete blocker was found after the duplicate-sync repair and matching resource freeze. Root's combined regression is separate; this report does not assert its pending outcome. The three independent stream cases, author resource cases and previous focused runs must not be added again if included in that combined runner. Source inspection is not another passing test count.

Actual provider SSE reliability, hosted changes/deletion delivery, native rendering/interaction, live OAuth journeys, framework publication/update distribution and overall product acceptance remain unverified. The resource API adds access to retained guidance, not authority to execute framework scripts, expand permissions or spend budgets.
