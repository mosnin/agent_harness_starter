# Integrated source closeout

At source revision 4f718d4, the desktop sidecar (provider SDKs bundled), UI and team-server source bundles built successfully. Bundle hashes are retained in ../evidence/integrated-closeout-v1/bundles.json. Node 24.19.0 TypeScript noEmit passed after the test-gate edits. No installed application was launched or replaced.

The expanded restricted Work gate includes browser accounting, browser task parsing and team storage authority along with the existing Work/Helm suite. Its final run passed 423 tests in 40 files with 3 explicit skips, taking 107.90 seconds. Log: ../evidence/integrated-closeout-v1/work.rawlog. This supersedes the unrestricted first run's 426-pass summary for accepted evidence.

## Process inspection evidence correction

Inspection found four tests across Helm service, source checks and code service invoking ps and swallowing inspection errors as if no process existed. Three were selected in the combined Work gate. That initial run finished before the stop request; its three cleanup assertions are not accepted as evidence. The restricted runner now sets HADES_TEST_NO_PROCESS_INSPECTION=1 and the relevant tests skip explicitly. They remain available in an unrestricted environment; those ps probes now capture stderr and propagate inspection errors rather than converting them to successful cleanup evidence. Only normal status 1 with empty stderr is interpreted as no matching PID. No alternate process-enumeration route was used.

Independent read-only review checked the guards and error handling. An initially overbroad guard on a separate self-PID test was removed before finalization. The selected restricted suite skips exactly three tests. Historical test counts containing those assertions must not be cited as proof of descendant cleanup under denied inspection.

These results prove source regression and bundling only. Native compile/install, provider-backed execution and usage enforcement, live seven-plugin journeys, enterprise policy integration, browser/passkeys/spatial UX, and long-running comparative acceptance remain open.
