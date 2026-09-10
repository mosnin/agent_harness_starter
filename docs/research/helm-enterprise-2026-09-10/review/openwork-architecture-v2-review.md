# Independent OpenWork architecture v2 review

Disposition: **supported with explicit coverage gaps**. The exact corrected report resolves OW-R01 through OW-R04. All twenty bounded source review units are supported. No further correction to this report is required by this review. The result accepts the narrowed source extraction only; it does not establish current runtime behavior, complete enterprise capability, kernel admission or overall product acceptance.

| Bound artifact | SHA-256 |
| --- | --- |
| `research/openwork-architecture-v2/integration-report.md` | `75e10b67586db712787b9a49d6749c49d4c19f34eb9559f0e312304650c5c505` |
| `research/openwork-architecture-v2/evidence-spans.json` | `44e4b71d3e5863f451770ba4b60c0f82a548ffed4c891c26ddfb213a5204ffb1` |
| `research/openwork-architecture-v2/source-references.json` | `7b4f92571864f413e689c06a1ec3603eab55a6162a3898fdb13193550359884f` |

This is a fresh independent review under the `review-research-evidence` skill at OpenWork pin `88b1eec4aa8bddd7a8abccbb39285c41bd1c7c36`. I did not produce either source report, the correction or the acquisition. I reused the previous review as a baseline, checked the report delta, reviewed the corrected source boundaries, and independently revalidated the source and locator bindings. The v1 report and review remain intact.

## Correction decisions

| Prior finding | Exact supporting context | Result |
| --- | --- | --- |
| OW-R01 actor distinction | OW15/OW16; `apps/server/src/server.ts:647–673,1953–1993` | Closed. The report now distinguishes viewer read-only/no approval from collaborator permission replies, with host routes kept distinct. No owner-only permission-reply guarantee remains. |
| OW-R02 admission persistence | OW34/OW46; `ee/apps/den-api/src/automations/cloud-agent-executor.ts:77–84,525–615` | Closed. The report claims an awaited injected callback before `sendTurn`, expressly leaving the callback’s persistence, transaction and fencing unverified. |
| OW-R03 WebMCP stale-frame guarantee | OW30/OW31/OW47; `apps/desktop/electron/webmcp-policy.mjs:58–97,124–185` | Closed. The report distinguishes explicit denial from `allowed:true, originKeyed:false`, and identifies the absent consumer rather than claiming universal final stale-frame denial. |
| OW-R04 locator precision | OW04/OW10/OW18/OW22/OW40/OW43 and new OW44/OW45 | Closed. Correct end lines are 83, 69, 7, 714, 18 and 236 respectively. Build and SDK declarations now have exact spans and report links at package lines 15 and 56. |

OW04 is retained as a correctly labeled supplemental development-dependency span. It no longer serves as the SDK/build citation. OW44/OW45 supply that evidence. OW46 locates the callback type and OW47 the policy fallback. The full [machine findings](openwork-architecture-v2-review.findings.json) provide all twenty unit verdicts, all 47 evidence relations and all 43 source/receipt checks.

## Evidence integrity and supported scope

All **43 complete source bodies, totaling 810,247 bytes**, still match their original SHA-256, Git blob identities and retained pinned tree. All **43 connector receipt bodies** match their source; receipt hashes and inherited observation timestamps match the v2 references. All **47 quoted character spans, line ranges and source hashes** validate. No line range now exceeds EOF. The four inherited tree/commit/license artifacts still match their original bytes. This review created no new source observation.

The source establishes substantive desktop → embedded server → managed OpenCode integration beyond package metadata. That remains a configured source path, with an unresolved installed engine revision and a v2 module labeled as a prototype. Declared SDK ranges/build scripts do not prove an installed binary or successful build. The report preserves distinctions between health and provider readiness, local persistence and multi-process ownership, capability contracts and adapter fulfillment, thread settlement and artifact acceptance, and plan entitlements and license rights.

The MIT/EE inventory remains supported by the retained license text and REUSE map, with the client-side MIT provision, third-party obligations and historical exceptions preserved. No component-level or subscription entitlement clearance follows. Unexecuted recovery test definitions remain source evidence only.

## Gates that remain open

The corrected report explicitly leaves the production admission callback/receipt transaction and WebMCP consumer/isolated preload unacquired. Complete policy evaluator/route/actor coverage, revocation-cache behavior, adapter installation coverage, remote provisioning and cross-process lifetime ownership also remain unverified. All sources are one project at one development pin; they do not supply independent replication or complete neutral/challenge discovery.

No complete governed semantic dossier, claim set or required-question IDs accompanies this architecture report. These findings are report-bound extraction findings, not a kernel semantic-review payload or host admission. No source code, test, provider, listener, native application or real runtime was executed; no acquisition or acceptance callback occurred. Current deployed behavior, runtime/restart/native acceptance and matched product superiority remain separate gates.
