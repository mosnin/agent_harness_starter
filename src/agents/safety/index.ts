export {
	UNTRUSTED_PREAMBLE,
	isUntrusted,
	renderUntrusted,
	untrusted,
	untrustedFromScreen,
	unwrapUntrusted,
} from "./untrusted";
export type {
	ExtractOptions,
	RenderUntrustedOptions,
	ScreenTextSource,
	UntrustedChannel,
	UntrustedOrigin,
	UntrustedText,
} from "./untrusted";

export {
	assessmentIsUnsafe,
	describeAssessment,
	screenObservation,
	screenUntrustedSegments,
	screeningUnavailable,
} from "./screen-injection";
export type {
	ScreenAssessment,
	ScreenInjectionFinding,
	ScreenPattern,
	ScreenScreeningOptions,
	ScreenThreatType,
	ScreenVerdict,
} from "./screen-injection";

export { describeProvenance, traceActionProvenance } from "./provenance";
export type { ActionProvenance, ProvenanceInput, ProvenanceSource } from "./provenance";

export { evaluateScreenSafety } from "./enforcement";
export type {
	ScreenSafetyDecision,
	ScreenSafetyInput,
	ScreenSafetyOutcome,
	ScreenSafetyReason,
} from "./enforcement";
