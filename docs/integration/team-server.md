# Team chat across Macs

Team chat is a shared HTTP service with SQLite storage, bearer-authenticated members, owner-managed invitations, channels, reply threads, read cursors and explicit agent invocation. The desktop can host it while open. For always-on service, the same server is shipped as `team-server.js` in the application resources and can be built with `node scripts/build-team-server.mjs`.

Use Node **22.13 or newer**. The Mac bundle supplies Node 22.22.2. CLI harness commands that do not use this service retain their existing Node requirements.

```sh
node dist/desktop/team-server.js init --data-dir /srv/hades-team --name Builders --owner Preston
node dist/desktop/team-server.js serve --data-dir /srv/hades-team --port 18770
node dist/desktop/team-server.js invite --data-dir /srv/hades-team
```

Run `serve` under your host's normal process supervisor. Back up the private data folder, including SQLite's WAL while the server is running. `owner.json` is a host-side administrative credential stored with mode 0600; do not send it to members. `invite` issues a one-use invitation valid for 24 hours. The host owner can issue invitations without exposing an HTTP bootstrap route. Desktop joiners receive ordinary member access; the desktop-created team's creator is an owner.

For other Macs, put an HTTPS reverse proxy in front of the loopback service. For example, with an existing domain and Caddy installation:

```caddy
team.example.com {
    reverse_proxy 127.0.0.1:18770
}
```

Use the actual HTTPS origin in **Team chat → Join a team**, along with an invitation and your name. A plain HTTP remote origin is rejected. The service binds only to loopback and rejects browser Origin requests. No remote deployment, DNS, or certificate provisioning is performed by the desktop.

The member credential is saved through the native Keychain bridge and never returned to the webview. Tokens are hashed in the server database. Membership revocation applies to subsequent reads and writes. Sending uses stable request IDs; reusing an ID with different content is rejected. Agent deliveries record the server's persistent team identity so replacing a service at the same address does not redirect old replies into a new team.

Channels currently share the team's membership. Private channels, SSO, attachment uploads, presence, mobile clients and an account recovery UI are not implemented. Team requests, local agent rooms and Slack threads are distinct workflows. Local two-client HTTP, persistence and revocation tests pass; cross-Mac HTTPS deployment remains an external verification gate.
