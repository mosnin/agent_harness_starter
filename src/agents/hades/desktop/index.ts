export {
  DESKTOP_COMMAND_KINDS,
  DESKTOP_EVENT_KINDS,
  detectDesktopInference,
  isDesktopCommand,
  isDesktopEvent,
  encodeDesktopMessage,
  decodeDesktopCommand,
  decodeDesktopEvent,
  MAX_DESKTOP_VOICE_BYTES,
  MAX_DESKTOP_CHAT_CHARS,
  MAX_DESKTOP_LINE_CHARS,
  desktopVoiceOversize,
} from "./contract";
export type { DesktopCommand, DesktopEvent, DesktopInference } from "./contract";

export { createDesktopHost } from "./host";
export type { DesktopHost, DesktopHostOptions } from "./host";

export { runDesktopSidecar, readCappedLines } from "./sidecar";
export type { SidecarOptions } from "./sidecar";

export { createCapRunner } from "./cap";
export type { CapRunner } from "./cap";
