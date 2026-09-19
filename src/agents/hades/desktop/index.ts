export {
  DESKTOP_COMMAND_KINDS,
  DESKTOP_EVENT_KINDS,
  detectDesktopInference,
  isDesktopCommand,
  isDesktopEvent,
  encodeDesktopMessage,
  decodeDesktopCommand,
  decodeDesktopEvent,
} from "./contract";
export type { DesktopCommand, DesktopEvent, DesktopInference } from "./contract";

export { createDesktopHost } from "./host";
export type { DesktopHost, DesktopHostOptions } from "./host";

export { runDesktopSidecar } from "./sidecar";
export type { SidecarOptions } from "./sidecar";

export { createCapRunner } from "./cap";
export type { CapRunner } from "./cap";
