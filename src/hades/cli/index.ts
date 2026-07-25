export { HadesCli, HADES_SUBCOMMANDS } from "./cli";
export type { CliResult, HadesCliDeps } from "./cli";
export { buildHadesCli, HADES_VERSION } from "./build";
export type { BuildCliOptions } from "./build";
export { runExecCommand } from "./exec-command";
export type { ExecCommandResult, ExecCommandOptions } from "./exec-command";
export { runToolsCommand } from "./tools-command";
export type { ToolsCommandDeps } from "./tools-command";
export { runBackendsCommand } from "./backends-command";
export type { BackendsCommandDeps, BanditStateStore } from "./backends-command";
export { runReconcileAdoptCommand } from "./backends-adopt-command";
export type { AdoptCommandDeps } from "./backends-adopt-command";
export { runShowdownCommand } from "./showdown-command";
export type { ShowdownCommandDeps, ShowdownCommandResult, ShowdownCommandFsDeps } from "./showdown-command";
export { runShowdownLiveCommand } from "./showdown-live-command";
export type { ShowdownLiveCommandDeps } from "./showdown-live-command";
export { runShowdownVerifyCommand, runShowdownReadyCommand } from "./showdown-verify-command";
export type { ShowdownVerifyCommandDeps } from "./showdown-verify-command";
export { runBackendsLearnCommand } from "./backends-learn-command";
export type { BackendsLearnCommandDeps } from "./backends-learn-command";
export { runSkillsHubCommand } from "./skills-hub-command";
export type { SkillsHubDeps, SkillsHubCommandResult } from "./skills-hub-command";
export { buildBrowserCommand } from "./browser-command";
export type {
  BrowserCliDeps,
  BrowserCliCommand,
  BrowserOpenRequest,
  BrowserOpenResult,
  BrowserProbeResult,
  BrowserBenchReportLike,
} from "./browser-command";
export { defaultBrowserCliDeps } from "./browser-deps";
export type { BrowserDepsIo } from "./browser-deps";
export { runGatewayCommand } from "./gateway-command";
export type { GatewayCommandIo } from "./gateway-command";
export { buildGatewayDeps, buildGatewayDepsFromEnv } from "./gateway-deps";
// (GatewayAgentEngine/EngineProbe themselves are exported via the gateway
// barrel — not re-exported here to keep the root `export *` barrels
// unambiguous.)
export type { GatewayCliDeps } from "./gateway-deps";
