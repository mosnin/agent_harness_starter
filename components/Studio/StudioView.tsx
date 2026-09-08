"use client";

import { ApprovalPrompt } from "./ApprovalPrompt";
import { ArtifactList } from "./ArtifactList";
import { KillSwitch } from "./KillSwitch";
import { ObservationPanel } from "./ObservationPanel";
import { SessionStatusBar } from "./SessionStatusBar";
import { StepTimeline } from "./StepTimeline";
import { currentStep, isSessionLive } from "./format";
import type { StudioState } from "./types";

export interface StudioViewProps extends StudioState {
	nowUnixMs: number;
	stopping?: boolean;
	pendingApprovalId?: string | null;
	onStop: () => void;
	onApprove: (approvalId: string) => void;
	onDeny: (approvalId: string) => void;
}

/**
 * Presentational shell. Everything it renders comes from props, so the whole surface can be
 * exercised without a transport; `components/Studio/index.tsx` is the only part that fetches.
 */
export function StudioView({
	session,
	observation,
	steps,
	approvals,
	artifacts,
	error,
	nowUnixMs,
	stopping = false,
	pendingApprovalId = null,
	onStop,
	onApprove,
	onDeny,
}: StudioViewProps) {
	const live = isSessionLive(session, nowUnixMs);

	return (
		<main className="min-h-screen bg-neutral-950 p-4 text-neutral-100">
			<header className="sticky top-0 z-10 mb-4 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-neutral-700 bg-neutral-900/95 p-4 backdrop-blur">
				<div>
					<h1 className="text-lg font-bold">Studio</h1>
					<p className="text-xs text-neutral-400">
						An agent is recording a demo on this Mac. You can stop it at any moment.
					</p>
				</div>
				<KillSwitch armed={live} stopping={stopping} onStop={onStop} />
			</header>

			{error && (
				// biome-ignore lint/a11y/useSemanticElements: alert has no HTML element equivalent
				<p
					role="alert"
					className="mb-4 rounded-lg border border-red-500 bg-red-950/50 p-3 text-sm text-red-100"
				>
					{error}
				</p>
			)}

			<ApprovalPrompt
				approvals={approvals}
				pendingId={pendingApprovalId}
				onApprove={onApprove}
				onDeny={onDeny}
			/>

			<div className="mt-4 grid gap-4 lg:grid-cols-[3fr_2fr]">
				<div className="space-y-4">
					<ObservationPanel
						observation={observation}
						current={currentStep(steps)}
						live={live}
					/>
					<ArtifactList artifacts={artifacts} />
				</div>
				<div className="space-y-4">
					<SessionStatusBar session={session} live={live} nowUnixMs={nowUnixMs} />
					<StepTimeline steps={steps} />
				</div>
			</div>
		</main>
	);
}
