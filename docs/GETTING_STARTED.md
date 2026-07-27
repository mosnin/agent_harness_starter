# Getting started with hades

```
█  █  ▄▀▀▄  █▀▀▄  █▀▀▀  ▄▀▀▀
████  █▄▄█  █  █  █▀▀   ▀▀▀▄
█  █  █  █  █▄▄▀  █▄▄▄  ▀▄▄▀
the agent you can prove
```

Three commands get you from nothing to a working install.

```bash
npx hades setup      # preview what would change (writes nothing)
npx hades setup --write
npx hades doctor     # confirm it worked
```

## `hades setup`

Previews by default. It shows a readiness report and the exact list of things
it *would* create, and writes nothing until you pass `--write`.

```
hades setup — preview (nothing written)

Readiness:
  ok    node           v22.22.2 (>= 20 required)
  warn  data-dir       /home/you/.hades does not exist yet
                       -> Run `hades setup --write` to create it.
  warn  provider-keys  none of ANTHROPIC_API_KEY, OPENAI_API_KEY are set — every
                       provider path runs as a labelled [mock]
  ok    platform       linux

Would do:
  + create data directory /home/you/.hades
  + write config /home/you/.hades/config.json

Re-run with --write to apply.
```

An existing `config.json` is never overwritten — setup reports it and leaves it
alone.

**Flags:** `--write` applies; `--json` gives machine-readable output.

## `hades doctor`

Read-only. Writes nothing, ever. **Exits non-zero when a check fails**, so it
works as a CI or pre-flight gate:

```bash
hades doctor || echo "not ready"
```

Checks: node version (≥ 20), data directory exists and is writable, config file
present, provider keys, platform.

Provider keys are reported **by variable name only** — the value is never read
out, printed, or logged.

## `hades update`

Reports the installed version, the newest published one, and the exact upgrade
command. It **never modifies your install by itself**:

```
installed: v0.1.0
latest:    v0.2.0

An update is available. To upgrade:  npm install -g hades-agent@latest
(hades never rewrites its own install — run that yourself.)
```

If the newest version can't be determined (offline, or no lookup configured) it
says exactly that rather than implying you're current.

## Running with and without a provider key

hades runs fully offline. Without `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, every
provider path returns a deterministic result prefixed `[mock]`, and benchmark
output is labelled `(modeled)`. Nothing is ever presented as a real model result
when it isn't one.

With a key exported, the same commands use real inference.

## The banner

The wordmark prints only for a bare `hades` or `hades help` **on an interactive
terminal**. Piped output, CI, and `--json` consumers get clean text. Suppress it
anywhere with `HADES_NO_BANNER=1`; colour also honours `NO_COLOR` and
`TERM=dumb`.

## Where things live

| Path | What |
|---|---|
| `$HADES_DATA_DIR` (default `.hades`) | All durable state |
| `<dataDir>/config.json` | Config written by `setup --write` |
| `<dataDir>/skills/` | SKILL.md library |

Override the root with `HADES_DATA_DIR=/some/path`.

## Next

```bash
hades help          # every command
hades tui           # live terminal dashboard
hades showdown run  # the verification demo
```
