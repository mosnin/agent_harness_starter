# Hades audit remediation

Baseline: main 83e63c1f667b7c061def6a67ebed3ddeebcf4210. Work only on
claude/hermes-swarm-framework-vbhrot. Preserve the audit checkout.

Acceptance sequence:
1. Reject fabricated/unrelated evidence; no automatic correctness certificate from completion counts or synthetic calibration.
2. A real CLI conversation can read/edit files with bounded tools, use provider configuration, stop, and resume persisted history.
3. Inline swarm and desktop/TUI use a real executor or report missing setup; demo is explicit.
4. Preserve provider usage/cost, label unknown measurements and local surrogate baselines honestly.
5. Repair path alias handling, test typing and portable CI; run regression probes, full tests and product builds.
6. Record exact validation and remaining provider/platform limits. Do not claim competitor superiority without matched real runs.

Local acceptance completed: 507 test files, 11,862 tests passed, one skipped;
zero TypeScript diagnostics; CLI/swarm/desktop JS builds and packaged HTTP/file/
process smoke tests passed. Original audit trust and path probes rechecked.
Details and remaining provider/platform/competitive gates: docs/AUDIT_REMEDIATION.md.
