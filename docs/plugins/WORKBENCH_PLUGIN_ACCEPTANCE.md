# Workbench plugin integration acceptance

2026-09-10. Independent in-process acceptance of root-owned Workbench integration. **6/6 tests passed**, `/tmp/workbench-ecosystem-final.log`.

```sh
./node_modules/.bin/vitest run src/desktop/__tests__/workbench-ecosystem.test.ts --maxWorkers=1
```

Uses actual Workbench dispatch, sessions, agent loop, tool registry, approval queue, ecosystem service and bundled Company OS service. Model client is an injected deterministic text-tool fixture. Account transport and write adapter are offline fixtures; webhook listener is explicitly replaced by the existing OfflineWebhookFixture. No listener, provider request, native application, executable script or external write was used.

Verified behaviors:

1. `plugins_write` produces actual desktop approval, with no adapter write before approval; Allow dispatches exactly once under the conversation's account/tenant.
2. Denying approval prevents write.
3. Stop while approval is pending prevents write.
4. Tool-supplied profile fields are rejected as Invalid plugin input. A separately created Workbench profile cannot read the original profile's cached account records.
5. `/company-os` is refused while disabled without calling the model. Once enabled, the actual bundled framework text appears in model input and `company_os_read` runs successfully through the real tool registry.
6. The actual Workbench snapshot barrier drains an active modeled plugin SSE stream before invoking a snapshot callback, blocks new chat admission while held, then resumes background observation. This directly invokes the host barrier; it does not execute the public backup filesystem/archive operation.

An intermediate rerun failed before tests with ENOSPC during module transformation. Root removed only identified generated build artifacts; final strengthened suite above passed after space recovery. This environmental failure is not counted as a source regression or acceptance test.

No new production defect reproduced. This proves local orchestration boundaries, not provider quality, real account authorization, packaged/native approval UI, deployed mutation effects, Keychain, remote SSE behavior or a real backup. All candidate changes remain uncommitted source at review time.

## Candidate hashes

| File | SHA-256 |
|---|---|
| `src/desktop/core/workbench-service.ts` | `9211dd9e403fc93de21fed1817fd7b6f553e4f354597c636131eda875d5af02d` |
| `src/desktop/core/ecosystem-tools.ts` | `d1c47e1f36cc47bcbc432e32e35b20c2e28ab3193141dbba9dd594b859e5fe6b` |
| `src/desktop/core/ecosystem-service.ts` | `ba281ee38874e8f4e227a654d6e7396dd090606605370cf9c0f1fe48e342dff5` |
| `src/desktop/core/company-os-tools.ts` | `a64d2529bff72aa3618ab2935fb9173676da3d659d35e37726a2f3f2ac5bd877` |
| `src/desktop/core/company-os.ts` | `87f9a993c6df8ea88675cb17b6d1cd11abf547f208a85a15dfca86ebf18ea782` |
| `third_party/company-os/manifest.json` | `b0231803a9b61fc4be2d65d61c59ee606214a9fd729a48bc35f97c226b6b9790` |
| `src/desktop/__tests__/workbench-ecosystem.test.ts` | `82cfa04db51b1bc31a105d9ccef98e1cfa77bd34864a79d79e0331dd312f1604` |
