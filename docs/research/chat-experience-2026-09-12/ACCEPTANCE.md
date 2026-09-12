# Single-conversation experience checkpoint

Status: source and renderer verified; native installation not accepted.

The default experience is one conversation. Work, Helm, and Orca expose saved, conversation-scoped progress, output and stop actions. Coding changes open an inline review that reuses existing verification and integration controls. New work and navigation controls are excluded from that review. Work and Helm are removed from primary navigation; utility pages are under More. Existing records and internal compatibility views are retained.

Ordinary chat creates a distinct managed workspace when no project is attached. Agent/profile names are optional in the UI. Chat guidance uses available tools without requiring users to fill in task plans or choose an execution mode. No hidden orchestration instructions are inserted into user messages.

Model inputs in settings and chat are selects populated through provider catalogs. Draft catalogs cannot forward saved credentials to another provider or endpoint. Catalog failures retain retry controls. Unavailable saved models are identified without silently changing them. Model selection is captured before new-chat creation so a render cannot overwrite the choice.

Codex sign-in attempts are coalesced and fenced against late cancellation/completion. The current real Hades account and its default gpt-5.6-sol model successfully completed a Workbench file-read workflow: one successful file_ops read, exact random README marker in the last assistant answer, no errors. The test used a disposable project/session store; only the unrelated webhook listener was replaced with an offline fixture. Account details and credentials are omitted from retained results. A separate saved model, gpt-5.4-mini, was absent from the actual account catalog; no saved profile was silently changed.

## Verification

- 86 tests across 9 focused files passed, including restored conversation progress, stale response isolation, cancellation, inline review, provider dropdowns and auth races.
- Full TypeScript check passed.
- Frontend and bundled backend builds passed.
- Real Chromium renderer with an injected fixture bridge: desktop and compact widths, no horizontal overflow or page errors, review opens in view, composer remains available, draft survives task updates, model selection submits the selected value.
- Independent source review caught and repaired Orca record-shape, polling/output retention, and focus identity defects.

## Limits

Renderer screenshots and interactions use fixture task data. They do not prove live worker execution, native WebKit behavior, all provider authentication, or release readiness. The actual subscription test proves the source backend's account/inference/file-read path, not the previously installed app. No new Mac app was packaged, installed, or launched in this checkpoint. The broader enterprise release goal remains incomplete.

Evidence is retained in the adjacent evidence directory. The live test source is deliberately outside the automatic test suite to prevent unsolicited subscription calls.
