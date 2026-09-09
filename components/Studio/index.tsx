"use client";

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { AgentEvent } from "@/agents/types";
import { StudioView } from "./StudioView";
import { createStudioReducer, resolveApproval } from "./reducer";
import { EMPTY_STUDIO_STATE } from "./types";
import type { StudioDryRun, StudioSession, StudioState } from "./types";

type StudioAction =
	| { kind: "event"; event: AgentEvent }
	| { kind: "session"; session: StudioSession | null }
	| { kind: "approval_answered"; approvalId: string }
	| { kind: "transport_error"; message: string };

export interface StudioProps {
	sessionId: string;
	/** SSE endpoint emitting `AgentEvent` frames for this session. */
	streamUrl?: string;
	/** Endpoint that answers an approval and revokes the lease. */
	controlUrl?: string;
	/** Turns a protocol `imageRef` into a loadable URL. */
	resolveImageUrl?: (imageRef: string) => string;
	/**
	 * The plan the agent intends to run, shown before anything moves the cursor. The Studio does
	 * not ask for it: the control plane resolves the plan and passes it in. Omit it and the
	 * preview simply does not render.
	 */
	dryRun?: StudioDryRun | null;
	startingDryRun?: boolean;
	onConfirmDryRun?: () => void;
	onCancelDryRun?: () => void;
}

export function Studio({
	sessionId,
	streamUrl = `/api/studio/stream?sessionId=${encodeURIComponent(sessionId)}`,
	controlUrl = "/api/studio/control",
	resolveImageUrl,
	dryRun = null,
	startingDryRun = false,
	onConfirmDryRun,
	onCancelDryRun,
}: StudioProps) {
	const reduceEvent = useMemo(
		() => createStudioReducer({ resolveImageUrl }),
		[resolveImageUrl]
	);

	const reducer = useCallback(
		(state: StudioState, action: StudioAction): StudioState => {
			switch (action.kind) {
				case "event":
					return reduceEvent(state, action.event);
				case "session":
					return { ...state, session: action.session };
				case "approval_answered":
					return resolveApproval(state, action.approvalId);
				case "transport_error":
					return { ...state, error: action.message, failure: null };
			}
		},
		[reduceEvent]
	);

	const [state, dispatch] = useReducer(reducer, EMPTY_STUDIO_STATE);
	const [nowUnixMs, setNowUnixMs] = useState(() => Date.now());
	const [stopping, setStopping] = useState(false);
	const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);

	useEffect(() => {
		const timer = setInterval(() => setNowUnixMs(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		const source = new EventSource(streamUrl);

		source.onmessage = (message: MessageEvent<string>) => {
			try {
				const parsed = JSON.parse(message.data) as
					| { type: "session"; session: StudioSession }
					| AgentEvent;
				if ("type" in parsed && parsed.type === "session") {
					dispatch({ kind: "session", session: parsed.session });
					return;
				}
				dispatch({ kind: "event", event: parsed as AgentEvent });
			} catch {
				dispatch({ kind: "transport_error", message: "Received an unreadable event." });
			}
		};

		source.onerror = () => {
			dispatch({
				kind: "transport_error",
				message: "Lost the connection to the runner. The session lease still applies.",
			});
		};

		return () => source.close();
	}, [streamUrl]);

	const post = useCallback(
		async (body: Record<string, unknown>) => {
			const response = await fetch(controlUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId, ...body }),
			});
			if (!response.ok) throw new Error(`Control request failed (${response.status})`);
		},
		[controlUrl, sessionId]
	);

	const onStop = useCallback(async () => {
		setStopping(true);
		try {
			await post({ action: "kill_switch" });
		} catch (error) {
			dispatch({
				kind: "transport_error",
				message: error instanceof Error ? error.message : "Could not reach the runner to stop it.",
			});
		} finally {
			setStopping(false);
		}
	}, [post]);

	const answer = useCallback(
		async (approvalId: string, approved: boolean) => {
			setPendingApprovalId(approvalId);
			try {
				await post({ action: "approval", approvalId, approved });
				dispatch({ kind: "approval_answered", approvalId });
			} catch (error) {
				dispatch({
					kind: "transport_error",
					message: error instanceof Error ? error.message : "Could not send your answer.",
				});
			} finally {
				setPendingApprovalId(null);
			}
		},
		[post]
	);

	return (
		<StudioView
			{...state}
			nowUnixMs={nowUnixMs}
			stopping={stopping}
			pendingApprovalId={pendingApprovalId}
			dryRun={dryRun}
			startingDryRun={startingDryRun}
			onConfirmDryRun={onConfirmDryRun}
			onCancelDryRun={onCancelDryRun}
			onStop={onStop}
			onApprove={(approvalId) => void answer(approvalId, true)}
			onDeny={(approvalId) => void answer(approvalId, false)}
		/>
	);
}

export { StudioView } from "./StudioView";
export { createStudioReducer, resolveApproval } from "./reducer";
export * from "./types";
