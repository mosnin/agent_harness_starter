import { build } from "esbuild";
await build({ entryPoints: ["src/desktop/team/main.ts"], outfile: "dist/desktop/team-server.js", bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "info" });
