# Browser task usage settlement

Six failing regression cases reproduced missing usage, missing counts, negative/string/NaN counts and unsafe integer overflow being treated as valid accounting. The desktop.done handler now accepts only explicit safe nonnegative integer counts whose accumulated total remains safe. Missing or malformed receipts retain previous measured tokens and set usageUnknown. Valid partial counts are retained with usageUnknown; a later complete receipt does not clear prior uncertainty. An explicit complete zero report is accepted. Cancellation keeps its cancelled status and retains uncertainty.

The existing chat admission path refuses tasks with usageUnknown or inFlight usage. Existing budget extension also refuses unknown usage. This patch repairs settlement input validation rather than adding provider-side limits. Missing receipts can arise before any provider call; absent an authoritative no-dispatch receipt, they cannot be safely interpreted as zero.

Validation: 18 tests pass across browser-usage-settlement and browser-task, including 10 new accounting cases. TypeScript noEmit passes. Tests exercise the actual Workbench event handler with injected session storage and browser transport. No listeners, real browser connection, provider calls, native control, or installed-app acceptance were exercised.

Independent read-only review found no blocking accounting defect and confirmed desktop.started clears prior usage. Review scope covered the initial eight settlement cases; the subsequent two cases cover cancellation and accumulated overflow. Full event lifecycle/provider acceptance remains open.
