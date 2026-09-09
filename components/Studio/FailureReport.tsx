"use client";

import { failureCodeLabel, failureRemediation, failureStepLabel, formatClock } from "./format";
import type { StudioFailure } from "./types";

interface FailureReportProps {
	failure: StudioFailure | null;
	/** Raw transport-level message, shown when no structured failure exists. */
	fallbackMessage?: string | null;
}

/**
 * "Failed" on its own leaves a user unable to tell whether their app is broken or the agent is.
 * This renders the evidence the agent already had when it stopped: where in the plan it was,
 * what it was reaching for, how many things matched that description, what the runner said to do
 * about it, and the frame it was looking at.
 */
export function FailureReport({ failure, fallbackMessage = null }: FailureReportProps) {
	if (!failure) {
		if (!fallbackMessage) return null;
		return (
			// biome-ignore lint/a11y/useSemanticElements: alert has no HTML element equivalent
			<p
				role="alert"
				className="mb-4 rounded-lg border border-red-500 bg-red-950/50 p-3 text-sm text-red-100"
			>
				{fallbackMessage}
			</p>
		);
	}

	const headline = failureCodeLabel(failure.code) ?? "The agent stopped";
	const remediation = failureRemediation(failure);
	const stepLabel = failureStepLabel(failure);
	const ambiguous = failure.candidateCount != null && failure.candidateCount > 1;

	return (
		<section
			// biome-ignore lint/a11y/useSemanticElements: alert has no HTML element equivalent
			role="alert"
			aria-labelledby="studio-failure-heading"
			className="mb-4 rounded-xl border-2 border-red-500 bg-red-950/40 p-4"
		>
			<h2 id="studio-failure-heading" className="text-base font-semibold text-red-100">
				{headline}
			</h2>
			<p className="mt-1 text-sm text-red-100">{failure.message}</p>

			<dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
				{stepLabel && (
					<div>
						<dt className="text-xs font-medium uppercase tracking-wide text-red-300">
							Where it stopped
						</dt>
						<dd className="text-neutral-100">{stepLabel}</dd>
					</div>
				)}
				{failure.target && (
					<div>
						<dt className="text-xs font-medium uppercase tracking-wide text-red-300">
							What it was looking for
						</dt>
						<dd className="text-neutral-100">{failure.target}</dd>
					</div>
				)}
				{failure.candidateCount != null && (
					<div>
						<dt className="text-xs font-medium uppercase tracking-wide text-red-300">
							Elements that matched
						</dt>
						<dd className="text-neutral-100">
							{failure.candidateCount}
							{ambiguous ? " — too many to choose from" : ""}
						</dd>
					</div>
				)}
				{failure.toolName && (
					<div>
						<dt className="text-xs font-medium uppercase tracking-wide text-red-300">Tool</dt>
						<dd className="font-mono text-xs text-neutral-100">{failure.toolName}</dd>
					</div>
				)}
				{failure.code && (
					<div>
						<dt className="text-xs font-medium uppercase tracking-wide text-red-300">Code</dt>
						<dd className="font-mono text-xs text-neutral-100">{failure.code}</dd>
					</div>
				)}
			</dl>

			{failure.candidates && failure.candidates.length > 0 && (
				<div className="mt-3">
					<h3 className="text-xs font-medium uppercase tracking-wide text-red-300">
						It was choosing between
					</h3>
					<ul className="mt-1 list-inside list-disc text-sm text-neutral-100">
						{failure.candidates.map((candidate) => (
							<li key={candidate}>{candidate}</li>
						))}
					</ul>
				</div>
			)}

			{remediation && (
				<p className="mt-3 rounded-lg border border-red-700 bg-neutral-900 p-3 text-sm text-neutral-100">
					<span className="font-semibold text-red-200">What to do: </span>
					{remediation}
				</p>
			)}

			{failure.observationImageUrl && (
				<figure className="mt-3">
					<figcaption className="text-xs text-red-300">
						The screen the agent was looking at
						{failure.observationCapturedAtUnixMs
							? ` · ${formatClock(failure.observationCapturedAtUnixMs)}`
							: ""}
					</figcaption>
					<img
						src={failure.observationImageUrl}
						alt={`Screen capture from the moment the agent stopped${
							failure.target ? `, while looking for ${failure.target}` : ""
						}`}
						className="mt-1 h-auto w-full max-w-2xl rounded-lg border border-red-700"
					/>
				</figure>
			)}
		</section>
	);
}
