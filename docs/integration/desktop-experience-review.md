# Desktop experience review — September 7, 2026

Scope: the installed Tauri application, from baseline `6f478adc659e24679eb293a08a9d4624b2479b06`. This pass changes the workbench, editor controls, Team chat and Slack setup. It does not replace the application with a website.

## Implemented

| Area | Change |
| --- | --- |
| Typography | System font, 14px reading text, 13px controls, 12px secondary text at default zoom. Relative units carry the text-size preference into controls, metadata and the editor. Terminal text follows the preference. |
| Icons | One 16px stroke family, including explicit Team chat, Slack and Harness icons. Icon-only controls have accessible names and tooltips. Removed mixed Unicode action symbols. |
| Spacing | Shared control sizing, page gutters, section headings and fields. Sidebar content scrolls independently of its profile/settings footer. Long file, project and model labels truncate within their controls. |
| Navigation | Compact sidebar opens as a drawer instead of being permanently hidden. More retains its expansion and scroll position. Less-used window actions live in a labeled disclosure. Inspectors overlay the workspace at constrained widths. |
| Simplicity | Removed the duplicate decorative memory map; all memories remain in a single list with Details and Forget actions. Removed unused decorative styles and redundant action-label ornaments. |
| Accessibility | Dialogs receive focus, contain Tab navigation, make the underlying workbench inert, and return focus on close. Disabled, hidden and collapsed controls are excluded from the focus cycle. Disclosure focus rings, selected navigation semantics and higher-contrast theme rules are included. |
| Editing | Background updates preserve inspector drafts and full text selections. Preservation is scoped to the project and preview file. Terminal redraws no longer steal typing focus. |
| Collaboration | Team updates preserve the member disclosure, sidebar position and composer selection. Failed Slack operations retain credential drafts in the form; successful credential saves still clear those fields. Slack setup has a bounded, scrollable page. |
| Shortcuts | Customized bindings appear in tooltips and keyboard hints. Option-modified characters and shifted punctuation match the configured shortcuts. |

## Verification

- TypeScript typecheck passed.
- All 73 desktop test files passed: 1,564 tests.
- New interaction regressions exercise dialogs, selection/draft preservation, terminal focus, compact navigation, file ownership, team updates, Slack failures and shortcut matching.
- Native macOS build and deep, strict ad-hoc signature verification passed using `script/build_and_run.sh --build-only`.
- No provider or backend interface changes in this pass. Prior live-provider evidence belongs to its recorded earlier revision.

## Native acceptance still pending

The Mac was locked at both native inspection attempts. No screenshots or rendered visual acceptance are claimed for this revision. DOM tests do not establish WebKit layout, VoiceOver quality or a polished appearance.

When the screen is available, inspect the actual installed app at 1440×900, 1024×768 and a compact window, in light and dark appearances, then at enlarged text size. Review chat/composer, long project names, expanded sidebar, workspace/editor, each inspector, settings/dialog keyboard loops, Team chat and Slack setup. Confirm traffic-light clearance, readable contrast, focus visibility, scroll containment and no clipped controls. Capture screenshots from that native build; older screenshots are not evidence for this pass.

## Native follow-through on 2026-09-07

The Mac became available. Actual Hades screenshots showed the chat, workspace,
file explorer and CodeMirror editor. The current Markdown/plain-text editor wraps
long prose. Project switching now clears the previous project's inspector state;
an asynchronous directory-list timeout keeps the sidecar responsive during a
stalled folder read. Protected Documents access remains unverified.

A real `pwd` command returned the disposable project path through the PTY and
could be added to a chat draft. The terminal renderer was blank while WebKit
reported `document.visibilityState=hidden` during automation, and repainted after
a view change. Temporary diagnostic code and an unproven repaint workaround were
removed. This observation does not establish normal foreground terminal quality.
The broad light/dark/compact/large-text and VoiceOver acceptance matrix remains
open. The latest screenshot also showed an actual provider catalog 401; the
source now directs authentication failures to API-key/account settings rather
than incorrectly suggesting that a model-ID change will fix authorization.
