# Independent OpenWork architecture v1 source review

Disposition: **needs revision** for three scope statements and locator precision. Seventeen of twenty bounded review units are supported; three are uncertain. The remaining architecture extraction is useful evidence at the retained pin. This is neither runtime acceptance nor acceptance of Hades/Helm as an enterprise product.

Reviewed report: `research/openwork-architecture-v1/integration-report.md`, SHA-256 `f418af7f63ca8c8af394b54c1a570ee0454b0419288b5347a013b288a1fcd251`.

Repository: `different-ai/openwork`; pinned commit `88b1eec4aa8bddd7a8abccbb39285c41bd1c7c36`. The reviewer did not write the report or acquire these sources. Review used the `review-research-evidence` skill and retained inert source representations only. No acquisition, dependency installation, source execution, provider request, native launch or acceptance callback was performed.

## Required corrections

**OW-R01 — Server access and permissions (OW15, OW16).** “Non-owner permission reply restrictions” does not identify the actual actor boundary. In `apps/server/src/server.ts:648–668`, viewer tokens are read-only, while the explicit rationale at lines 656–662 allows collaborators to answer OpenCode permission requests. The token/proxy routing at lines 1953–1993 is a separate boundary. Correct the report to: **viewer tokens cannot mutate or approve; collaborator tokens may answer permission prompts; host/owner-only routes remain distinct from client proxy routes**. No new source is needed. This is a wording correction, not a demonstrated authorization vulnerability.

**OW-R02 — EE cloud execution (OW34).** The report says the executor “persists” a receipt first. `ee/apps/den-api/src/automations/cloud-agent-executor.ts:77–84` declares `onAdmitted` as an injected callback. Lines 575–615 await it with worker, workspace, thread and message identity before the final authority check and `sendTurn`; its implementation is absent from the 43 captured files. `scheduler-loop.ts:1–3,25–28` imports the missing service implementation. Correct the report to: **the executor awaits the caller-supplied admission callback before submitting work; the callback’s durability, transaction and fencing are unverified**. The existing evidence establishes ordering. A production caller and receipt-store transaction would be necessary to establish persistence; absence from this acquisition does not show the repository lacks it.

**OW-R03 — WebMCP frame rights (OW30, OW31).** The blanket statement that detached/navigated frames fail exceeds the retained helper. `apps/desktop/electron/webmcp-policy.mjs:124–172` rejects frames already detached at entry and checks policy/delegation. Lines 58–81 discard isolated-policy reads when URL/origin changes. But lines 177–185 return `allowed: true, originKeyed: false` when the final isolated policy is absent or not origin-keyed. Correct the report to describe the explicit denial checks and **distinguish denied from allowed but not origin-keyed**. The consuming browser-panel/WebMCP caller and isolated preload are not retained, so this evidence cannot establish that every stale/navigated frame is denied immediately before execution. No runtime exploit is claimed.

**OW-R04 — Exact source locators.** Six declared end lines exceed EOF. Their character spans and hashes match the actual clamped source slices; the defect is the line metadata.

| Evidence ID | Source path | Declared lines | Correct retained lines |
| --- | --- | --- | --- |
| OW04 | `apps/server/package.json` | 79–111 | 79–83 |
| OW10 | `apps/server/src/runtime-db.ts` | 34–79 | 34–69 |
| OW18 | `apps/server/src/opencode-plugins/managed-policy.ts` | 1–8 | 1–7 |
| OW22 | `apps/server/src/mcp.ts` | 662–722 | 662–714 |
| OW40 | `REUSE.toml` | 1–19 | 1–18 |
| OW43 | `apps/server/src/task-recovery.test.ts` | 119–238 | 119–236 |

OW04 also points to the wrong package section for the SDK/build claim: retained lines 79–83 contain `opencode-chrome-devtools`; the managed-policy plugin build is at **line 15** and `@opencode-ai/sdk` at **line 56**. Replace or supplement OW04 with those exact spans and update the report citation. The full captured package and launcher implementations support the integration claim once cited precisely. All text needed for these corrections is already retained. The producer report and locators were left intact by this reviewer.

## Supported boundaries and their limits

The [machine-readable findings](openwork-architecture-v1-review.findings.json) give a verdict for all twenty units and entailment notes for all 43 spans. The following distinctions are material to using the supported results:

- **Real source integration beyond metadata:** desktop startup imports and calls the embedded server; configured managed mode launches an OpenCode child. Package declarations and launcher code support an actual integration path. They do not identify the installed engine revision, prove binary execution, or make the v2 prototype a verified production adapter. HTTP binds before managed engine readiness.
- **Generation management:** the pool coalesces generation changes and checks standby health, retaining the primary on health failure. A separate preparation failure can still permit promotion. Inactive draining sessions may be aborted. Those branches do not establish lossless or provider-ready rollover.
- **Persistence and local recovery:** captured SQLite/key-value implementations and atomic registry replacement are concrete code. Recovery reloads `running` records, persists `claimed` before sending, checks workspace/current-turn/policy state and skips `claimed` records after restart. Registry and recovery queues are process-local; no cross-host exactly-once effect ledger or lifetime ownership fence is established. Electron’s single-instance lock does not supply that guarantee for arbitrary CLI/server processes.
- **Authority:** captured plugin hooks invoke a policy client; missing policy URL/token is refused. Effective permissions summarize rules rather than enforce all routes. The evaluator and complete v1/v2 installation coverage are absent. Remembered grants are workspace/session scoped, but complete revocation semantics are unverified. EE auth checks scopes, token use/resource, membership and grant/session liveness; cache invalidation and all protected callers are unverified. An entitlement flag is not a license right.
- **Browser and native bridge:** supplied ownership, visibility, observation, approval and freshness checks occur in the captured browser action path, which returns an unverified, nonretryable outcome after input. Sensitive-field restrictions are selective. In-memory mailbox delivery/expiry and disconnect cancellation do not reverse a delivered effect. Caller authority, injected callbacks, frame handling and the WebMCP consumer remain separate coverage gaps.
- **Automation and settlement:** durable/idempotent capability declarations are contracts. Concrete EE code rechecks authority and observes thread-idle settlement after abort. That is neither whole-process-tree exit nor independent deliverable acceptance. The captured success branch exports a transcript and can use a generic assistant-text fallback. Test source proves the presence of intended regression cases, not execution of them.
- **Packaging and license split:** packaging lists bundles, helpers and sign hooks; it does not prove a signed/notarized release. The retained root/EE licenses and `REUSE.toml` support the MIT/EE split with third-party and historical exceptions, including the EE text’s client-side MIT provision. Subscription-defined Enterprise Features and exact component reuse clearance remain unresolved. This review supplies no legal clearance.

## Integrity, discovery and structural gate

All **43 complete source bodies (810,247 bytes)** match their SHA-256 values, Git blob identities and the retained pinned tree. All **43 connector receipt contents** exactly equal their corresponding body. All **43 quoted character spans** and full-source hashes validate. The six line metadata defects above do not alter those body/character checks. Four inherited identity/license artifacts were matched to the earlier acquisition; inheritance does not create a fresh observation.

This is a targeted path extraction from one project at one development pin. Different files and test definitions provide complementary source context, not independent replication. The preserved connector results and web cache misses are useful provenance, but they are not a neutral/challenge discovery campaign or a per-question search log. No exhaustive every-line, every-route or dependency review is claimed.

No complete `fces.semantic-review-dossier.v1`, governed claim set or required-question IDs were supplied for this architecture report. The findings are bound to the exact report digest above; they are **not kernel-admissible semantic findings or host admission**. A narrow versioned correction can resolve the four stated report defects without acquisition. Missing implementation bodies, current deployed behavior and runtime tests must remain open if later claims depend on them.
