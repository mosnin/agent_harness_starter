"use client";

import { formatClock, scopeLabel } from "./format";
import type { StudioApproval } from "./types";

interface ApprovalPromptProps {
	approvals: StudioApproval[];
	/** Approval id currently being submitted, if any. */
	pendingId?: string | null;
	onApprove: (approvalId: string) => void;
	onDeny: (approvalId: string) => void;
}

/**
 * The first approval surface in this repo. `approval_required` events land here; until the human
 * answers, the agent is blocked. Both answers are equally reachable — an approve-only affordance
 * would be a dark pattern on a tool that drives someone's machine.
 */
export function ApprovalPrompt({
	approvals,
	pendingId = null,
	onApprove,
	onDeny,
}: ApprovalPromptProps) {
	if (approvals.length === 0) return null;

	return (
		<section
			aria-labelledby="studio-approvals-heading"
			className="rounded-xl border-2 border-amber-500 bg-amber-950/40 p-4"
		>
			<h2 id="studio-approvals-heading" className="text-sm font-semibold text-amber-200">
				Approval needed ({approvals.length})
			</h2>

			<ul className="mt-3 space-y-3">
				{approvals.map((approval) => {
					const busy = pendingId === approval.approvalId;
					const detailsId = `approval-details-${approval.approvalId}`;
					return (
						<li
							key={approval.approvalId}
							// biome-ignore lint/a11y/useSemanticElements: alert has no HTML element equivalent
							role="alert"
							className="rounded-lg border border-amber-600 bg-neutral-900 p-3"
						>
							<p className="text-base font-semibold text-neutral-100">{approval.summary}</p>
							<p className="mt-1 font-mono text-xs text-neutral-400">
								{approval.toolName} · requested {formatClock(approval.requestedAtUnixMs)}
							</p>

							{approval.scopes.length > 0 && (
								<ul className="mt-2 flex flex-wrap gap-2">
									{approval.scopes.map((scope) => (
										<li
											key={scope}
											className="rounded-full bg-amber-900/60 px-2.5 py-0.5 text-xs text-amber-100"
										>
											{scopeLabel(scope)}
										</li>
									))}
								</ul>
							)}

							{approval.details && (
								<details className="mt-2">
									<summary className="cursor-pointer text-xs text-neutral-300">
										Exactly what was requested
									</summary>
									<pre
										id={detailsId}
										className="mt-1 overflow-x-auto rounded bg-neutral-950 p-2 text-xs text-neutral-300"
									>
										{approval.details}
									</pre>
								</details>
							)}

							<div className="mt-3 flex flex-wrap gap-2">
								<button
									type="button"
									onClick={() => onApprove(approval.approvalId)}
									disabled={busy}
									aria-label={`Approve: ${approval.summary}`}
									className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:bg-neutral-600"
								>
									{busy ? "Sending…" : "Approve this step"}
								</button>
								<button
									type="button"
									onClick={() => onDeny(approval.approvalId)}
									disabled={busy}
									aria-label={`Deny: ${approval.summary}`}
									className="rounded-md border border-neutral-500 px-4 py-2 text-sm font-semibold text-neutral-100 hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-300 disabled:cursor-not-allowed disabled:text-neutral-500"
								>
									Deny
								</button>
							</div>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
