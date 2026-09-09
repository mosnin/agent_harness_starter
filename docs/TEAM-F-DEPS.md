# Team F — dependencies needed but not added

Team E owns `package.json`. Nothing below was added; each is worked around for now.

## 1. `jsdom` (or `happy-dom`) + `@testing-library/react` — component tests

**Needed for:** rendering `components/Studio/**` in tests — asserting the kill switch is reachable
by keyboard, that `ApprovalPrompt` exposes both answers, and that the current-action line updates.

**Why it is blocked:** `vitest.config.ts` sets `environment: "node"` and neither a DOM
implementation nor a React testing library is installed, so no React component in this repo can be
mounted in a test.

**Workaround shipped:** every decision the Studio makes was pushed out of the components into two
pure modules — `components/Studio/reducer.ts` (event → state) and `components/Studio/format.ts`
(labels, lease liveness, current step) — which are covered in
`src/agents/__tests__/director-studio.test.ts` under the node environment. The `.tsx` files are
props-in/JSX-out only, so what remains untested is markup, not behaviour.

**To adopt:** add `jsdom` and `@testing-library/react` as devDependencies, then either set
`environment: "jsdom"` per-file with a `// @vitest-environment jsdom` docblock or add an
`environmentMatchGlobs` entry for `components/**`.

## 2. Nothing else

The tool pack, governance rules and director team use only `zod` and modules already in the repo.
No client library for the runner is needed here: `src/agents/tools/cap/client.ts` defines the
`DirectorClient` seam and Team E's transport implements it.
