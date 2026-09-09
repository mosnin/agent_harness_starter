import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalPrompt } from "../../../components/Studio/ApprovalPrompt";
import { DryRunSummary } from "../../../components/Studio/DryRunSummary";
import { FailureReport } from "../../../components/Studio/FailureReport";
import { KillSwitch } from "../../../components/Studio/KillSwitch";
import { ObservationPanel } from "../../../components/Studio/ObservationPanel";
import { StudioView } from "../../../components/Studio/StudioView";
import { EMPTY_STUDIO_STATE } from "../../../components/Studio/types";
import type {
	StudioApproval,
	StudioDryRun,
	StudioFailure,
	StudioSession,
	StudioStep,
} from "../../../components/Studio/types";

/**
 * Mounting tests for the surfaces that protect a user. The logic behind them is covered in
 * `director-studio.test.ts`; what is asserted here is only what a logic test cannot see — that
 * the kill switch is in the document, focusable, and fires from the keyboard; that the approval
 * prompt renders BOTH answers; and that the current action is announced rather than buried.
 */

afterEach(cleanup);

const NOW = 1_700_000_000_000;

function liveSession(overrides: Partial<StudioSession> = {}): StudioSession {
	return {
		sessionId: "sess-1",
		runId: "run-1",
		status: "active",
		grantedScopes: ["observe_screen", "control_pointer"],
		startedAtUnixMs: NOW - 30_000,
		expiresAtUnixMs: NOW + 600_000,
		killSwitchEngaged: false,
		...overrides,
	};
}

function step(overrides: Partial<StudioStep> = {}): StudioStep {
	return {
		id: "c1",
		index: 0,
		label: "Click Continue",
		actionType: "click",
		scope: "control_pointer",
		status: "running",
		atUnixMs: NOW,
		...overrides,
	};
}

describe("KillSwitch", () => {
	it("is in the document with a name that says what it does", () => {
		render(<KillSwitch armed onStop={() => {}} />);
		const button = screen.getByRole("button", {
			name: /stop the agent and revoke its access/i,
		});
		expect(button).toBeDefined();
		expect(button.getAttribute("aria-hidden")).toBeNull();
		expect(button.hasAttribute("inert")).toBe(false);
	});

	it("takes focus from the keyboard and fires on Enter", async () => {
		const onStop = vi.fn();
		const user = userEvent.setup();
		render(<KillSwitch armed onStop={onStop} />);

		await user.tab();
		const button = screen.getByRole("button", { name: /stop the agent/i });
		expect(document.activeElement).toBe(button);

		await user.keyboard("{Enter}");
		expect(onStop).toHaveBeenCalledTimes(1);
	});

	it("fires on Space too — a button that only answers the mouse is not a kill switch", async () => {
		const onStop = vi.fn();
		const user = userEvent.setup();
		render(<KillSwitch armed onStop={onStop} />);

		await user.tab();
		await user.keyboard(" ");
		expect(onStop).toHaveBeenCalledTimes(1);
	});

	it("cannot be fired while no lease is held", async () => {
		const onStop = vi.fn();
		const user = userEvent.setup();
		render(<KillSwitch armed={false} onStop={onStop} />);

		const button = screen.getByRole("button", { name: /stop the agent/i });
		expect(button).toHaveProperty("disabled", true);
		await user.click(button);
		expect(onStop).not.toHaveBeenCalled();
	});

	it("says it is stopping instead of silently swallowing the second press", async () => {
		const onStop = vi.fn();
		const user = userEvent.setup();
		render(<KillSwitch armed stopping onStop={onStop} />);

		const button = screen.getByRole("button", { name: /stop the agent/i });
		expect(button.textContent).toMatch(/stopping/i);
		await user.click(button);
		expect(onStop).not.toHaveBeenCalled();
	});
});

describe("KillSwitch inside the full Studio", () => {
	function renderStudio(onStop = vi.fn()) {
		render(
			<StudioView
				{...EMPTY_STUDIO_STATE}
				session={liveSession()}
				steps={[step()]}
				nowUnixMs={NOW}
				onStop={onStop}
				onApprove={() => {}}
				onDeny={() => {}}
			/>
		);
		return onStop;
	}

	it("is reachable by keyboard from the top of the page", async () => {
		const user = userEvent.setup();
		const onStop = renderStudio();
		const button = screen.getByRole("button", { name: /stop the agent/i });

		for (let i = 0; i < 10 && document.activeElement !== button; i++) {
			await user.tab();
		}
		expect(document.activeElement).toBe(button);

		await user.keyboard("{Enter}");
		expect(onStop).toHaveBeenCalledTimes(1);
	});

	it("is armed exactly when the session is live", () => {
		render(
			<StudioView
				{...EMPTY_STUDIO_STATE}
				session={liveSession({ killSwitchEngaged: true })}
				nowUnixMs={NOW}
				onStop={() => {}}
				onApprove={() => {}}
				onDeny={() => {}}
			/>
		);
		expect(screen.getByRole("button", { name: /stop the agent/i })).toHaveProperty(
			"disabled",
			true
		);
	});
});

describe("ApprovalPrompt", () => {
	const approval: StudioApproval = {
		approvalId: "ap-1",
		toolName: "cap_act",
		summary: "Click Continue in Safari",
		scopes: ["control_pointer"],
		requestedAtUnixMs: NOW,
		details: '{"action":{"type":"click"}}',
	};

	it("exposes both answers, both enabled, both named", () => {
		render(
			<ApprovalPrompt approvals={[approval]} onApprove={() => {}} onDeny={() => {}} />
		);
		const region = screen.getByRole("alert");
		const approve = within(region).getByRole("button", { name: /^approve:/i });
		const deny = within(region).getByRole("button", { name: /^deny:/i });

		expect(approve).toHaveProperty("disabled", false);
		expect(deny).toHaveProperty("disabled", false);
	});

	it("routes each answer to its own handler from the keyboard", async () => {
		const onApprove = vi.fn();
		const onDeny = vi.fn();
		const user = userEvent.setup();
		render(
			<ApprovalPrompt approvals={[approval]} onApprove={onApprove} onDeny={onDeny} />
		);

		screen.getByRole("button", { name: /^deny:/i }).focus();
		await user.keyboard("{Enter}");
		expect(onDeny).toHaveBeenCalledWith("ap-1");
		expect(onApprove).not.toHaveBeenCalled();

		screen.getByRole("button", { name: /^approve:/i }).focus();
		await user.keyboard("{Enter}");
		expect(onApprove).toHaveBeenCalledWith("ap-1");
	});

	it("announces the request and shows exactly what was asked for", () => {
		render(
			<ApprovalPrompt approvals={[approval]} onApprove={() => {}} onDeny={() => {}} />
		);
		const region = screen.getByRole("alert");
		expect(region.textContent).toContain("Click Continue in Safari");
		expect(region.textContent).toContain("Move and click your pointer");
		expect(screen.getByText(/exactly what was requested/i)).toBeDefined();
	});

	it("locks both answers while one is in flight, so a double answer is impossible", () => {
		render(
			<ApprovalPrompt
				approvals={[approval]}
				pendingId="ap-1"
				onApprove={() => {}}
				onDeny={() => {}}
			/>
		);
		expect(screen.getByRole("button", { name: /^approve:/i })).toHaveProperty("disabled", true);
		expect(screen.getByRole("button", { name: /^deny:/i })).toHaveProperty("disabled", true);
	});

	it("renders nothing when there is nothing to answer", () => {
		const { container } = render(
			<ApprovalPrompt approvals={[]} onApprove={() => {}} onDeny={() => {}} />
		);
		expect(container.innerHTML).toBe("");
	});
});

describe("ObservationPanel — the current action", () => {
	it("names the step in flight in a live region", () => {
		render(<ObservationPanel observation={null} current={step()} live />);
		const status = screen.getByText("Click Continue").closest("output");
		expect(status).not.toBeNull();
		expect(status?.getAttribute("aria-live")).toBe("polite");
	});

	it("updates when the agent moves to the next step", () => {
		const { rerender } = render(<ObservationPanel observation={null} current={step()} live />);
		expect(screen.getByText("Click Continue")).toBeDefined();

		rerender(
			<ObservationPanel
				observation={null}
				current={step({ id: "c2", index: 1, label: "Type the search query" })}
				live
			/>
		);
		expect(screen.queryByText("Click Continue")).toBeNull();
		expect(screen.getByText("Type the search query")).toBeDefined();
	});

	it("says so plainly rather than showing an empty box before the first step", () => {
		render(<ObservationPanel observation={null} current={null} live={false} />);
		expect(screen.getByText(/waiting for the agent's first step/i)).toBeDefined();
		expect(screen.getByText(/no frame captured yet/i)).toBeDefined();
	});

	it("stops announcing once the session is no longer live", () => {
		render(<ObservationPanel observation={null} current={step()} live={false} />);
		const status = screen.getByText("Click Continue").closest("output");
		expect(status?.getAttribute("aria-live")).toBe("off");
	});

	it("describes the screen capture for a screen reader", () => {
		render(
			<ObservationPanel
				observation={{
					frameId: "f1",
					imageUrl: "https://example.test/f1.png",
					width: 1440,
					height: 900,
					capturedAtUnixMs: NOW,
					focusedWindowTitle: "Safari — Pricing",
					redactedWindows: ["1Password"],
				}}
				current={step()}
				live
			/>
		);
		expect(screen.getByAltText(/focused window: Safari — Pricing/i)).toBeDefined();
		expect(screen.getByText(/1 window\(s\) withheld/i)).toBeDefined();
	});
});

describe("FailureReport", () => {
	const failure: StudioFailure = {
		message: "4 elements match that description.",
		code: "target_ambiguous",
		remediation: "Add the button's title so only one element matches.",
		stepId: "c7",
		stepIndex: 6,
		stepLabel: "Click Continue",
		toolName: "cap_act",
		target: "Continue · AXButton",
		candidateCount: 4,
		candidates: ["Continue · AXButton", "Continue to checkout · AXButton"],
		observationFrameId: "f9",
		observationImageUrl: "https://example.test/f9.png",
		observationCapturedAtUnixMs: NOW,
		atUnixMs: NOW,
	};

	it("says where in the plan it stopped, not just that it failed", () => {
		render(<FailureReport failure={failure} />);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("Step 7");
		expect(alert.textContent).toContain("Click Continue");
	});

	it("names the element it wanted and how many things matched", () => {
		render(<FailureReport failure={failure} />);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("Continue · AXButton");
		expect(alert.textContent).toContain("4");
		expect(alert.textContent).toMatch(/too many to choose from/i);
	});

	it("carries the protocol's remediation through verbatim", () => {
		render(<FailureReport failure={failure} />);
		expect(
			screen.getByText(/add the button's title so only one element matches/i)
		).toBeDefined();
	});

	it("shows the frame the agent was looking at, described for a screen reader", () => {
		render(<FailureReport failure={failure} />);
		const image = screen.getByAltText(/screen capture from the moment the agent stopped/i);
		expect(image.getAttribute("src")).toBe("https://example.test/f9.png");
	});

	it("falls back to advice when the control plane sends no remediation", () => {
		render(
			<FailureReport failure={{ ...failure, remediation: null, code: "target_not_found" }} />
		);
		expect(screen.getByRole("alert").textContent).toMatch(/different state than the plan assumed/i);
	});

	it("still surfaces a bare transport error when there is no structured failure", () => {
		render(<FailureReport failure={null} fallbackMessage="Lost the connection to the runner." />);
		expect(screen.getByRole("alert").textContent).toContain("Lost the connection");
	});

	it("renders nothing when nothing has gone wrong", () => {
		const { container } = render(<FailureReport failure={null} />);
		expect(container.innerHTML).toBe("");
	});
});

describe("DryRunSummary", () => {
	const dryRun: StudioDryRun = {
		summary: "Record a 40-second walkthrough of the pricing page.",
		steps: [
			{
				id: "p1",
				label: "Open Safari",
				actionType: "launchApplication",
				scope: "control_applications",
				application: "Safari",
				estimatedMs: 3_000,
			},
			{
				id: "p2",
				label: "Click Continue",
				actionType: "click",
				scope: "control_pointer",
				application: "Safari",
				estimatedMs: 1_500,
				requiresApproval: true,
			},
		],
		applications: [
			{ bundleId: "com.apple.Safari", name: "Safari", allowed: true },
			{ bundleId: "com.figma.Desktop", name: "Figma", allowed: false },
		],
		scopes: ["observe_screen", "control_pointer", "control_applications"],
		estimatedDurationMs: 42_000,
		generatedAtUnixMs: NOW,
	};

	it("shows the plan, the applications and the scopes before anything moves", () => {
		render(<DryRunSummary dryRun={dryRun} session={liveSession()} />);
		const region = screen.getByRole("region", { name: /before anything moves/i });
		expect(region.textContent).toContain("Record a 40-second walkthrough");
		expect(region.textContent).toContain("Safari");
		expect(region.textContent).toContain("Figma");
		expect(region.textContent).toContain("Open and focus applications");
		expect(region.textContent).toMatch(/about 42s/i);
	});

	it("marks the authority the session does not hold yet", () => {
		render(<DryRunSummary dryRun={dryRun} session={liveSession()} />);
		const region = screen.getByRole("region", { name: /before anything moves/i });
		expect(region.textContent).toContain("Open and focus applications — not granted yet");
		expect(region.textContent).toContain("Starting this grants 1 new authority");
	});

	it("flags an application outside the allowed list", () => {
		render(<DryRunSummary dryRun={dryRun} session={liveSession()} />);
		expect(screen.getByText(/Figma — not on your allowed list/)).toBeDefined();
	});

	it("marks the steps that will stop and ask", () => {
		render(<DryRunSummary dryRun={dryRun} session={liveSession()} />);
		expect(screen.getByText(/asks first/i)).toBeDefined();
	});

	it("puts both answers on the keyboard and does not start on its own", async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const user = userEvent.setup();
		render(
			<DryRunSummary
				dryRun={dryRun}
				session={liveSession()}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>
		);

		screen.getByRole("button", { name: /not now/i }).focus();
		await user.keyboard("{Enter}");
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();

		screen.getByRole("button", { name: /start this plan/i }).focus();
		await user.keyboard("{Enter}");
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it("says it is still working rather than showing an empty plan", () => {
		render(
			<DryRunSummary
				dryRun={{ ...dryRun, loading: true, steps: [] }}
				session={liveSession()}
			/>
		);
		expect(screen.getByText(/working out what the agent would do/i)).toBeDefined();
	});

	it("renders nothing when the control plane supplied no plan", () => {
		const { container } = render(<DryRunSummary dryRun={null} session={liveSession()} />);
		expect(container.innerHTML).toBe("");
	});

	it("appears in the Studio above the timeline when a plan is supplied", () => {
		render(
			<StudioView
				{...EMPTY_STUDIO_STATE}
				session={liveSession()}
				dryRun={dryRun}
				nowUnixMs={NOW}
				onStop={() => {}}
				onApprove={() => {}}
				onDeny={() => {}}
			/>
		);
		expect(screen.getByRole("region", { name: /before anything moves/i })).toBeDefined();
	});
});
