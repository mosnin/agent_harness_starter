"use client";

interface KillSwitchProps {
	/** True while the agent holds authority over the machine. */
	armed: boolean;
	/** Set while the stop request is in flight. */
	stopping?: boolean;
	onStop: () => void;
}

/**
 * The one control that must never be ambiguous. It is always rendered, always reachable by
 * keyboard, never behind a confirmation, and it says what it does in words rather than an icon.
 */
export function KillSwitch({ armed, stopping = false, onStop }: KillSwitchProps) {
	const disabled = !armed || stopping;

	return (
		<div className="flex items-center gap-3">
			<button
				type="button"
				onClick={onStop}
				disabled={disabled}
				aria-label="Stop the agent and revoke its access to this Mac"
				aria-disabled={disabled}
				className="rounded-lg bg-red-600 px-6 py-3 text-base font-bold uppercase tracking-wide text-white shadow-lg transition-colors hover:bg-red-500 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-red-300 disabled:cursor-not-allowed disabled:bg-neutral-600 disabled:text-neutral-300"
			>
				{stopping ? "Stopping…" : "Stop agent"}
			</button>
			<p className="max-w-xs text-xs text-neutral-400">
				{armed
					? "Revokes the session lease immediately. The agent cannot act again without a new grant."
					: "The agent holds no lease on this Mac."}
			</p>
		</div>
	);
}
