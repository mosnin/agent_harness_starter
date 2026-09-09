"use client";

import { dryRunDurationMs, dryRunMissingScopes, formatDuration, scopeLabel } from "./format";
import type { StudioDryRun, StudioSession } from "./types";

interface DryRunSummaryProps {
	dryRun: StudioDryRun | null;
	session: StudioSession | null;
	/** Set while the confirmation is in flight. */
	starting?: boolean;
	onConfirm?: () => void;
	onCancel?: () => void;
}

/**
 * Consent before the first move. The kill switch is reactive — it can only undo what has already
 * happened on someone's machine; this shows the plan, the applications it will touch, the scopes
 * it needs and roughly how long it will take while the cursor is still the user's.
 *
 * Purely presentational: the plan arrives as a prop. No protocol command is invented here.
 */
export function DryRunSummary({
	dryRun,
	session,
	starting = false,
	onConfirm,
	onCancel,
}: DryRunSummaryProps) {
	if (!dryRun) return null;

	if (dryRun.loading) {
		return (
			<section
				aria-labelledby="studio-dryrun-heading"
				className="rounded-xl border border-sky-700 bg-neutral-900 p-4"
			>
				<h2 id="studio-dryrun-heading" className="text-sm font-semibold text-sky-200">
					Before anything moves
				</h2>
				<output aria-live="polite" className="mt-2 block text-sm text-neutral-300">
					Working out what the agent would do…
				</output>
			</section>
		);
	}

	const totalMs = dryRunDurationMs(dryRun);
	const missingScopes = dryRunMissingScopes(dryRun, session);
	const disallowed = dryRun.applications.filter((app) => app.allowed === false);

	return (
		<section
			aria-labelledby="studio-dryrun-heading"
			className="rounded-xl border-2 border-sky-600 bg-neutral-900 p-4"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h2 id="studio-dryrun-heading" className="text-sm font-semibold text-sky-200">
					Before anything moves
				</h2>
				{totalMs != null && (
					<p className="text-xs text-neutral-400">about {formatDuration(totalMs)}</p>
				)}
			</div>

			<p className="mt-2 text-base text-neutral-100">{dryRun.summary}</p>

			<h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-neutral-400">
				Applications it will touch
			</h3>
			{dryRun.applications.length === 0 ? (
				<p className="mt-1 text-sm text-neutral-300">None — it only looks at the screen.</p>
			) : (
				<ul className="mt-1 flex flex-wrap gap-2">
					{dryRun.applications.map((app) => (
						<li
							key={app.bundleId}
							className={`rounded-full border px-2.5 py-0.5 text-xs ${
								app.allowed === false
									? "border-amber-500 text-amber-200"
									: "border-neutral-600 text-neutral-200"
							}`}
						>
							{app.name}
							{app.allowed === false ? " — not on your allowed list" : ""}
						</li>
					))}
				</ul>
			)}

			<h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-neutral-400">
				Authority it needs
			</h3>
			<ul className="mt-1 flex flex-wrap gap-2">
				{dryRun.scopes.map((scope) => (
					<li
						key={scope}
						className={`rounded-full border px-2.5 py-0.5 text-xs ${
							missingScopes.includes(scope)
								? "border-amber-500 text-amber-200"
								: "border-emerald-600 text-emerald-200"
						}`}
					>
						{scopeLabel(scope)}
						{missingScopes.includes(scope) ? " — not granted yet" : ""}
					</li>
				))}
			</ul>

			<h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-neutral-400">
				The plan, step by step
			</h3>
			<ol className="mt-1 space-y-1.5">
				{dryRun.steps.map((step, index) => (
					<li key={step.id} className="rounded-lg bg-neutral-950 p-2.5 text-sm">
						<p className="text-neutral-100">
							<span className="mr-2 font-mono text-xs text-neutral-500">
								{String(index + 1).padStart(2, "0")}
							</span>
							{step.label}
							{step.requiresApproval && (
								<span className="ml-2 rounded bg-amber-900 px-1.5 py-0.5 text-xs text-amber-100">
									asks first
								</span>
							)}
						</p>
						<p className="mt-0.5 font-mono text-xs text-neutral-400">
							{[step.actionType, scopeLabel(step.scope), step.application]
								.filter((part): part is string => Boolean(part))
								.join(" · ")}
							{step.estimatedMs != null ? ` · ${formatDuration(step.estimatedMs)}` : ""}
						</p>
					</li>
				))}
			</ol>

			{(missingScopes.length > 0 || disallowed.length > 0) && (
				<p className="mt-3 rounded-lg border border-amber-600 bg-amber-950/40 p-2.5 text-xs text-amber-100">
					Starting this grants {missingScopes.length} new{" "}
					{missingScopes.length === 1 ? "authority" : "authorities"}
					{disallowed.length > 0
						? ` and reaches ${disallowed.length} application(s) outside your allowed list`
						: ""}
					.
				</p>
			)}

			{(onConfirm || onCancel) && (
				<div className="mt-4 flex flex-wrap gap-2">
					{onConfirm && (
						<button
							type="button"
							onClick={onConfirm}
							disabled={starting}
							className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 disabled:cursor-not-allowed disabled:bg-neutral-600"
						>
							{starting ? "Starting…" : "Start this plan"}
						</button>
					)}
					{onCancel && (
						<button
							type="button"
							onClick={onCancel}
							disabled={starting}
							className="rounded-md border border-neutral-500 px-4 py-2 text-sm font-semibold text-neutral-100 hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-300 disabled:cursor-not-allowed disabled:text-neutral-500"
						>
							Not now
						</button>
					)}
				</div>
			)}
		</section>
	);
}
