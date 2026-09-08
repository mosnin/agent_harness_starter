"use client";

import { formatClock } from "./format";
import type { StudioStep, StudioStepStatus } from "./types";

const STATUS_STYLES: Record<StudioStepStatus, string> = {
	pending: "border-neutral-600 text-neutral-400",
	running: "border-sky-400 text-sky-200",
	succeeded: "border-emerald-500 text-emerald-200",
	failed: "border-red-500 text-red-200",
};

const STATUS_WORDS: Record<StudioStepStatus, string> = {
	pending: "Queued",
	running: "Running",
	succeeded: "Done",
	failed: "Failed",
};

interface StepTimelineProps {
	steps: StudioStep[];
}

export function StepTimeline({ steps }: StepTimelineProps) {
	return (
		<section
			aria-labelledby="studio-timeline-heading"
			className="rounded-xl border border-neutral-700 bg-neutral-900 p-4"
		>
			<h2 id="studio-timeline-heading" className="text-sm font-semibold text-neutral-200">
				Steps
			</h2>

			{steps.length === 0 ? (
				<p className="mt-2 text-xs text-neutral-400">Nothing has run yet.</p>
			) : (
				<ol className="mt-3 space-y-2">
					{steps.map((step) => (
						<li
							key={step.id}
							className={`rounded-lg border-l-4 bg-neutral-950 p-3 ${STATUS_STYLES[step.status]}`}
						>
							<div className="flex flex-wrap items-baseline justify-between gap-2">
								<p className="text-sm font-medium text-neutral-100">
									<span className="mr-2 font-mono text-xs text-neutral-500">
										{String(step.index + 1).padStart(2, "0")}
									</span>
									{step.label}
								</p>
								<p className="text-xs">
									<span className="font-semibold">{STATUS_WORDS[step.status]}</span>
									<span className="ml-2 text-neutral-500">{formatClock(step.atUnixMs)}</span>
								</p>
							</div>
							<p className="mt-1 font-mono text-xs text-neutral-400">
								{step.actionType} · {step.scope}
							</p>
							{step.detail && (
								<p className="mt-1 text-xs text-neutral-300">{step.detail}</p>
							)}
						</li>
					))}
				</ol>
			)}
		</section>
	);
}
