# Correction to the initial in-process regression receipt

The initial `inprocess-regression.md/json` recorded 196 passing assertions, but its assertion that no listener was selected was incorrect. `NODE_ENV=test` disables the Workbench Browser runtime, not `WebhookService`. Constructing the Workbench with webhook port 0 still attempts an ephemeral loopback listener; a caught listener error can leave unrelated assertions passing. Those results do not establish listener readiness or an entirely socket-free run.

The new Workbench routing, shutdown and enterprise fixtures, plus Orca Workbench-tools and readiness fixtures, now explicitly substitute `OfflineWebhookFixture`. This fixture does not implement or verify webhook behavior. A subsequent receipt must identify this substitution and use it only for the independently tested Workbench, scheduling, journal and Orca-admission behavior. Actual webhook/listener integration remains an open acceptance gate; do not retry it on this restricted host.

The original receipt is retained unchanged so the correction is traceable. Source-build success and the assertions that did pass must not be expanded into real runtime, provider or native acceptance.
