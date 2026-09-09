"use client";

import { formatClock } from "./format";
import type { StudioObservation, StudioStep } from "./types";
import { describeStep } from "./format";

interface ObservationPanelProps {
	observation: StudioObservation | null;
	/** The step the agent is on right now — displayed over the frame, never only in a log. */
	current: StudioStep | null;
	live: boolean;
}

export function ObservationPanel({ observation, current, live }: ObservationPanelProps) {
	return (
		<section
			aria-labelledby="studio-observation-heading"
			className="rounded-xl border border-neutral-700 bg-neutral-900 p-4"
		>
			<div className="flex items-baseline justify-between gap-4">
				<h2 id="studio-observation-heading" className="text-sm font-semibold text-neutral-200">
					What the agent sees
				</h2>
				{observation && (
					<span className="text-xs text-neutral-400">
						{observation.width}×{observation.height} · {formatClock(observation.capturedAtUnixMs)}
					</span>
				)}
			</div>

			<output
				aria-live={live ? "polite" : "off"}
				className="mt-3 block rounded-lg border border-neutral-700 bg-neutral-950 p-3"
			>
				<span className="block text-xs uppercase tracking-wide text-neutral-500">
					Current action
				</span>
				<span className="mt-1 block text-base font-semibold text-neutral-100">
					{current ? describeStep(current) : "Waiting for the agent's first step"}
				</span>
				{current && (
					<span className="mt-1 block font-mono text-xs text-neutral-400">
						{current.actionType} · {current.scope}
					</span>
				)}
			</output>

			<div className="mt-3 overflow-hidden rounded-lg border border-neutral-700 bg-black">
				{observation ? (
					<img
						src={observation.imageUrl}
						alt={
							observation.focusedWindowTitle
								? `Screen capture, focused window: ${observation.focusedWindowTitle}`
								: "Screen capture of the paired Mac"
						}
						width={observation.width}
						height={observation.height}
						className="h-auto w-full"
					/>
				) : (
					<p className="p-8 text-center text-sm text-neutral-500">No frame captured yet.</p>
				)}
			</div>

			{observation && observation.redactedWindows.length > 0 && (
				<p className="mt-2 text-xs text-amber-300">
					{observation.redactedWindows.length} window(s) withheld by your redaction rules:{" "}
					{observation.redactedWindows.join(", ")}
				</p>
			)}
		</section>
	);
}
