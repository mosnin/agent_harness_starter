# Third-party materials in the desktop integration

- The official `@openai/codex` 0.145.0 executable is included in native bundles. Its Apache 2.0 license is retained in `CODEX-LICENSE`. Hades is independently developed and is not an OpenAI product. ChatGPT authentication is managed by the official executable in a Hades-specific home.
- CodeMirror packages provide the embedded editor under their MIT licenses. Playwright Core provides browser tooling under Apache 2.0. Their installed package licenses are copied into the bundle by the packaging script.
- Orca (`stablyai/orca`, MIT, copyright 2026 Lovecast Inc.) informed the IDE requirements and project ownership design. The requested fork exists at `mosnin/orca`. `ORCA-LICENSE` preserves its license; Hades has not transplanted the Electron application or claimed full Orca feature parity.
- Rakazo (`elie222/rakazo`, Apache 2.0) informed the persistent teammate, shared computer and integration requirements. `RAKAZO-LICENSE` preserves its license. The new Hades team service is an independent implementation; its presence does not imply Rakazo service compatibility.
- Centaur (`paradigmxyz/centaur`) declares `Apache-2.0 OR MIT` in its root license. Its Slack/thread/durability requirements informed the independently implemented Hades Socket Mode bridge. No Centaur source is bundled; its Kubernetes, workflow and iron-proxy services are not included.

The licenses do not grant trademark rights or imply endorsement by these projects.
