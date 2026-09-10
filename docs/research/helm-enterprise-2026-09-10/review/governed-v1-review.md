# Independent review of the governed reference dossier v1

**Needs evidence at question level.** All 27 revised claims are supported when read with their explicit retained-source limitations; all 30 citations were assessed. Each of the six required questions is incomplete. Discovery and corroboration are limited. These findings do not accept the Helm product, G02 inventory, G19 operational comparison or a live runtime.

The reviewed object is `research/governed-v1/semantic-review-dossier.json`, schema `fces.semantic-review-dossier.v1`, canonical dossier SHA256 **`c7b24f6f277716c0ff01ae1718bbe91315c01334db154a451eda3701a0c06145`**. Its physical JSON file SHA256 is `5d64faead78bef4ae1d664014240b6e4033d2280defa4c0d0d888c74a8281e58`. Those are different serialization identities. The dossier digest was recomputed with `sha256:null`, sorted keys, UTF-8 and compact separators. The packet digest is `0b3f8871c40c1c259db6d6aa1876f77bd9866a24d1d32cbb0e1230b12b1a4cad`.

I did not produce the claims or source synthesis. This is a fresh question-level review of the new dossier, using the review-research-evidence skill, its exact findings contract and kernel governance reference. My earlier acquisition review identified narrower source readings, but it was bound to a different report and is preserved intact. This review did not acquire sources, run downloaded code, launch an app/runtime, execute a provider, invoke a reviewer callback or establish host admission.

The [machine findings](governed-v1-review.findings.json) contain exactly one review per included claim, every citation index, all required questions, and discovery/lineage judgments. The [binding receipt](governed-v1-review.binding.json) records the verification results and artifact hashes. Host admission and any subsequent kernel evaluation remain separate actions.

The integrity evidence is strong within the retained artifact boundary. All 41 embedded representations equal their original retained files: 35 text representations, five raw HTML counterparts and the previously retained OpenWork metadata body. All 30 citation spans and source hashes match. The original 27 input claims equal the included claim list; there are no compact-packet omissions. The dossier equals the successful preparation result, its governance equals the original build input, and the final archived packet equals the reviewed packet. Both final archive file hashes match their receipt.

All 25 retained repository bodies match their Git blob identities in the four captured recursive trees. I independently reconstructed all 2,932 tree objects, including each root linked from its commit receipt, with no mismatch. This matters because the tree responses report the requested commit SHA in their top-level `sha`; blindly comparing that field to the commit's root-tree SHA would have produced a false failure. The reconstructed objects establish the internal commit/tree/blob chain. They do not authenticate who fetched it or prove a released binary corresponds to that chain. The three discovery-supplement bodies and original log are byte-identical to their retained counterparts.

The semantic temporal judgments concern the propositions as limited to retained documentation and inspected source objects. **C01, C02, C08 and C09 remain ineligible under the packet's declared current policies** because S31, S32, S34 and S35 have no `content_observed_at`. S33 is also unknown but is not cited by an included claim. A verified immutable blob supports what that source contains; it does not fill an observation timestamp, prove the current default branch or establish installed-product behavior. The true semantic scope/temporal flags therefore do not override the kernel's explicit current-evidence gaps. Reusing these findings for an unbounded current or operational claim would exceed this review.

| Claim | Verdict | Retained source context | Consequential boundary |
|---|---|---|---|
| C01 | Supported | S31:3-7,19-92 | Codex crate/platform documentation only; unknown observed freshness. |
| C02 | Supported | S32:169-175,642-659,1343-1413 | Source loop/SQLite structure; no lossless recovery proof; unknown observed freshness. |
| C03 | Supported | S04:314-347,382-435,456-560 | Owner-provided check and incoming runtime settings preserved; sender-driven callers remain open. |
| C04 | Supported | S05:49-61,105-114,132-156,233-238 | Configured capacity with unbounded fallback; eligible materialize-before-evict order. |
| C05 | Supported | S07:23-148 | Tests exist; interrupted eviction test expects lost worker; unexecuted. |
| C06 | Supported | S03:1-23 | Cancellation distinctions are specific to experimental native verification. |
| C07 | Supported | S10:96-172 | Background flag, ancestry bound and derivation call; helper/reused-child authority uninspected. |
| C08 | Supported | S34:1149-1181,1270-1286,1319-1340 | Prompt threshold with Infinity fallback; tools remain passed; unknown observed freshness. |
| C09 | Supported | S35:1-37 | Instance wrapper delegates to unseen core registry; no persistence proof. |
| C10 | Supported | S15:20-35,52-74,126-158 | Guide separates liveness, exit proof and settlement. |
| C11 | Supported | S16:35-70,72-119,122-186 | Optional mutation receipt and transactional source path; process/remote admission unverified. |
| C12 | Supported | S17:116-184,207-283 | Stale-report and competing-claim test definitions; unexecuted. |
| C13 | Supported | S22:982-1022 | Nested subagents and version-qualified defaults; depth differs from spawn concurrency. |
| C14 | Supported | S22:861-883 | Main-session prompts and pre-2.1.186 history; mode/team exceptions remain. |
| C15 | Supported | S21:9-18,66,465-477 | Experimental, interactive teams with documented resume/status/stop/nesting limits. |
| C16 | Supported | S23:22-24,40-46 | Team coordination does not create worktree isolation. |
| C17 | Supported | S24:11-27,208-210 | Session/desktop/cloud lifetimes; idle firing, one catch-up and unexpired resume. |
| C18 | Supported | S26:449-460,558-562 | Cloud documentation plus connected desktop local access; local-session passage remains. |
| C19 | Supported | S27:424-450 | Remote account-file schedules conflict with local-folder/local-app instructions. |
| C20 | Supported | S28:10-13,27-32,41-47,80-82 | Separate products/history/access; gradual rollout and cloud-storage qualification. |
| C21 | Supported | S29:10-22 | Retirement notice conflicts with lower-body availability instructions. |
| C22 | Supported | S01:1-8 | Codex Web advertisement; actual route availability remains unknown. |
| C23 | Supported | S18:3-7,68-76,113-123 | Advertised desktop/core/Den platform; no executable enforcement trace. |
| C24 | Supported | S19:3-14; S20:48-60 | Root split with EE/client-side/historical/third-party qualifications. |
| C25 | Supported | S20:6-34,42-60 | Limited production exception and conditions; subscription definitions and component inventory absent. |
| C26 | Supported | S25:46-67,194-205,313-343 | SDK budgets, trailing events and loop result state; no deliverable acceptance. |
| C27 | Supported | S36:1, chars 1219-1238 | Metadata advertisement only; no executable OpenCode dependency proof. |

The corrected C03, C04 and C08 resolve the earlier overstatements. The Codex reload check depends on an owner being supplied; its permission restoration concerns incoming runtime values. Residency uses effective configuration with `usize::MAX` fallback, and the interrupted-eviction test is a limitation. OpenCode `agent.steps` is demonstrated as a final-step prompt threshold, while tools still reach the processor. None of these establishes universal permission inheritance, finite default capacity or a hard budget stop.

Claude documentation is version- and mode-sensitive. Current retained subagent docs allow nesting, describe changing depth defaults and separately explain spawn-concurrency exceptions. Background permission prompts can reach the main session; the old auto-denial behavior is historical. Experimental teams differ: no nested teams, interactive-only teammate spawning, missing in-process teammate restoration, and foreground-only subagents from in-process teammates. Cowork's cloud description coexists with local-session troubleshooting; its schedule article directly conflicts over local folders. C19 now reports that conflict without choosing an unsupported taxonomy.

The OpenAI evidence supports product distinctions and explicitly preserves uncertainty. Work cloud/local access and Codex local access are separately controlled, histories differ, and rollout is gradual. The agent article's retirement notice does not reconcile its lower availability instructions. The pinned Codex README advertises Codex Web; this constrains the inference from desktop-view help without proving the route is live. No closed implementation or actual account availability is inferred.

OpenWork's overview and metadata support advertisements, not an executable dependency or enterprise enforcement path. Its root license is split; the EE text adds production conditions, exceptions, a future MIT grant, client-side MIT and historical-version treatment. The five-user exception excludes Enterprise Features defined in unacquired subscription terms. A blanket MIT reuse decision, or an equally blanket claim that every `ee/` file is restricted identically, would exceed the evidence.

| Required question | Verdict | Supported contribution | Missing evidence |
|---|---|---|---|
| Q1 Codex | Incomplete | Optional-owner reload, incoming permission preservation, residency fallback, cancellation and eviction-test limits. | Effective defaults, sender-driven caller authority and complete recovery paths; observed freshness of S31/S32; discovery and independent corroboration. |
| Q2 OpenCode | Incomplete | Depth/background entry, derivation call, prompt threshold and registry-wrapper boundary. | Core registry persistence/restart, derivation helper, reused-child authority and hard budgets; S34/S35 observation freshness; issue dispositions and corroboration. |
| Q3 Orca | Incomplete | Optional-receipt transaction, guide doctrine and race-test source. | Process-readiness acceptance, capability mint/revoke, remote admission/recovery and executed races; discovery and independent evidence. |
| Q4 Claude | Incomplete | Version-qualified nesting/background/team behavior, schedules and SDK result/budget documentation. | Cowork local/cloud taxonomy conflict, reproducible discovery/screening and independent evidence; installed/account behavior before operational use. |
| Q5 OpenAI | Incomplete | Distinct products, history and controls; retirement conflict; advertised cloud link. | Retirement-body reconciliation, account rollout/route state if asserted operationally, discovery and independent corroboration. |
| Q6 OpenWork | Incomplete | Advertised architecture and metadata relationship; detailed license split. | Executable dependency/enforcement paths, subscription definition of Enterprise Features, file/version/component obligations, discovery and corroboration. |

The supplied questions deliberately name some gaps, and the dossier accurately identifies them. Naming a missing path or contradiction does not supply the underlying evidence or satisfy the declared two-independent-group floor. Runtime evidence would be required to promote these source observations to operational guarantees; its absence is a scope boundary, not a claim that the inspected systems lack the advertised capability.

Discovery is limited for substantive reasons. The supplement preserves three aggregated returns, 12 reported queries and 74 candidate entries. The queries include useful challenge terms and retained contrary Claude snippets plus OpenCode/Orca failure leads. However, exact query-to-result mapping and search timestamps are absent, every candidate uses the same generic screening rationale, and versioned issue applicability at the pinned revisions is unresolved. The formal ledgers correctly remain empty. Reaching the 35-body cap is a budget stop, not saturation. There is no fabricated neutral/challenge coverage, but there is also no reproducible question-level discovery acceptance.

Lineage handling is conservative, while corroboration remains insufficient. OpenAI documentation and repository source count as one family; Anthropic Code/SDK/Cowork as another; Orca guide/source/tests remain maintainer evidence. Raw HTML and its normalization are the same underlying source. The shared OpenCode/OpenWork independence label conservatively avoids inflating a relationship advertised in metadata; it does not prove common authorship or an executable dependency. Each question has one effective group against the requested two. More URLs in the same family would not close this gap.

The next evidence should target the named paths, contradictory product documentation and missing license terms; discovery should retain request/return attribution, timestamps, per-question screening and issue dispositions from the next authorized acquisition. Freshness should be restored by actual content observation, or the owner should adopt justified version-bound inputs using real retained identity evidence; no timestamp or version passage should be invented. A full component inventory and matched runtime evaluation remain outside this lane. The narrowed claims may inform candidate requirements, subject to the independent local Helm audit, while question-level acceptance remains withheld.
