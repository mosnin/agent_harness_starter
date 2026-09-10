# Plugin detail UI review

2026-09-10. Bounded DOM interaction acceptance in happy-dom; no native app,
provider connection, visual render or OS permission acceptance is implied.

## Red → green

The new keyboard assertion failed before repair: focus the **Show remaining
fields** button, activate it, and focus fell outside the plugin when the button
was removed. Root repaired the production view to focus the record detail
heading with `preventScroll` after expansion renders. The same assertion now
passes. This reviewer changed only the new test file and this receipt.

Final result: **9/9 tests pass**, 318ms total runner duration. Scoped strict
TypeScript checking of the new test and imported UI source also passes.

Cases cover:

- Scoped full service content, remaining-field expansion, escaped markup and
  retained keyboard focus after expansion.
- Foreign-account detail response rejection with saved fields preserved.
- Late detail response after profile switch and late failure after unmount.
- Metadata pushes preserve selected full content and focus, refresh notices
  work, and generated IDs remain unique.
- Changed account metadata clears the previous account's detail.
- Denied writes stay disabled; acknowledged read-off also disables writes.
- Disconnect retains the warning when remote revocation is unconfirmed.
- Missing framework status is visibly paused, never claims instructions are
  available, preserves saved enablement and allows disabling that preference.

## Exact tested source

| File | SHA256 |
| --- | --- |
| `src/desktop/ui/ecosystem-plugins.ts` | `8ee814ccf5eddc6faf42fe00a1c2de395acd148569951e17d7171d6ef3de70b0` |
| `src/desktop/__tests__/ecosystem-detail-ui.test.ts` | `914663087e82fc0a189523baab58d54b7a810dd9b258f1e1179d8869ffed25c2` |

Commands:

```sh
vitest run src/desktop/__tests__/ecosystem-detail-ui.test.ts
tsc --noEmit --skipLibCheck --strict --target es2022 --module esnext --moduleResolution bundler --esModuleInterop src/desktop/__tests__/ecosystem-detail-ui.test.ts
```

Retained local runner logs: `/tmp/ecosystem-detail-ui-tests.log` (red),
`/tmp/ecosystem-detail-ui-tests-green.log` (green),
`/tmp/ecosystem-detail-ui-types.log` (clean).
