"use client";

import { formatClock, formatDuration, leaseRemainingMs, scopeLabel, sessionStatusText } from "./format";
import type { StudioSession } from "./types";

interface SessionStatusBarProps {
	session: StudioSession | null;
	live: boolean;
	nowUnixMs: number;
}

export function SessionStatusBar({ session, live, nowUnixMs }: SessionStatusBarProps) {
	return (
		<section
			aria-labelledby="studio-session-heading"
			className="rounded-xl border border-neutral-700 bg-neutral-900 p-4"
		>
			<h2 id="studio-session-heading" className="text-sm font-semibold text-neutral-200">
				Session
			</h2>

			<output
				aria-live="polite"
				className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
			>
				<span
					aria-hidden="true"
					className={`inline-block h-2.5 w-2.5 rounded-full ${live ? "bg-emerald-400" : "bg-neutral-500"}`}
				/>
				<span className={live ? "font-semibold text-emerald-300" : "text-neutral-300"}>
					{sessionStatusText(session)}
				</span>
				{session && (
					<span className="text-neutral-400">
						lease ends in {formatDuration(leaseRemainingMs(session, nowUnixMs))}
					</span>
				)}
			</output>

			{session ? (
				<dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs text-neutral-400 sm:grid-cols-3">
					<div>
						<dt className="font-medium text-neutral-300">Session</dt>
						<dd className="font-mono">{session.sessionId}</dd>
					</div>
					<div>
						<dt className="font-medium text-neutral-300">Run</dt>
						<dd className="font-mono">{session.runId}</dd>
					</div>
					<div>
						<dt className="font-medium text-neutral-300">Started</dt>
						<dd>{formatClock(session.startedAtUnixMs)}</dd>
					</div>
				</dl>
			) : (
				<p className="mt-3 text-xs text-neutral-400">
					Nothing is running. Grant a session to let an agent record a demo.
				</p>
			)}

			{session && session.grantedScopes.length > 0 && (
				<div className="mt-3">
					<h3 className="text-xs font-medium text-neutral-300">You granted</h3>
					<ul className="mt-1 flex flex-wrap gap-2">
						{session.grantedScopes.map((scope) => (
							<li
								key={scope}
								className="rounded-full border border-neutral-600 px-2.5 py-0.5 text-xs text-neutral-200"
							>
								{scopeLabel(scope)}
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}
