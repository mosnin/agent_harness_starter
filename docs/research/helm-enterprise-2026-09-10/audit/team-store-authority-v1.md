# Current team membership authority

Offline SQLite regressions reproduced store operations trusting cached Member objects after revocation from another database connection, accepting a supplied owner role, and allowing a foreign store identity to read history. The HTTP routes already derive identities from bearer authentication; these findings are at the internal storage boundary, not proof of a remote authentication bypass.

Snapshot, history, channel creation, message sending/retry, read cursors, invitation creation and revocation now resolve current membership/role in the same BEGIN IMMEDIATE transaction as the operation. Revoked/foreign identities are refused before action execution. Snapshot identity comes from stored values. Member IDs remain trusted internal identity hints, not credentials; public callers still need bearer authentication.

Fourteen offline tests pass using real disposable SQLite stores, including separate connections, rejected-operation rollback, reopening and revoked duplicate-message requests. TypeScript noEmit passes. The first ten negative assertions failed before the repair (two owner-only cases previously rejected for role rather than revoked membership). Independent read-only review found no nested transaction or current compatibility blocker. Read operations now briefly reserve a writer transaction; concurrent lock contention and the live HTTP path were not tested. No listener or native app was launched.

This closes one storage authorization defect. Enterprise organization policy, agent execution role enforcement and installed multi-user workflows remain separate unfinished requirements.
