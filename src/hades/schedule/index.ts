/**
 * Phase 9 — the scheduler + verified-delivery package.
 *
 * A dependency-free Vixie cron engine (`cron.ts`), a deterministic clock seam
 * (`clock.ts`), a durable job store with atomic persistence + corruption
 * quarantine (`store.ts`), the misfire-policy-aware runner (`runner.ts`), and
 * the STYX-gated delivery router (`delivery.ts`) that can only ever label an
 * outbound message "verified" when the real gate + ed25519 certificate for
 * that exact output text say so.
 *
 * The CLI surface lives in `../cli/schedule-command` (`hades schedule ...`).
 */

export {
  CronParseError,
  parseCron,
  cronMatches,
  nextFireTime,
  nextFireTimes,
  describeCron,
} from "./cron";
export type { CronSchedule } from "./cron";

export { systemClock, ManualClock } from "./clock";
export type { Clock } from "./clock";

export { InMemoryJobStore, JsonFileJobStore } from "./store";
export type {
  MisfirePolicy,
  DeliverySpec,
  JobTask,
  RunOutcome,
  JobRunRecord,
  ScheduledJob,
  NewJobInput,
  JobStoreLoadReport,
  JobStore,
} from "./store";

export { SchedulerRunner } from "./runner";
export type {
  JobExecutionContext,
  JobExecutionResult,
  JobExecutor,
  SchedulerEvent,
  SchedulerRunnerOptions,
  TickReport,
} from "./runner";

export { VerifiedDeliveryRouter, formatDeliveryText, formatAbstentionNotice } from "./delivery";
export type {
  DeliveryReceipt,
  JobDeliverer,
  OutboundSender,
  VerifiedDeliveryOptions,
} from "./delivery";

export { ExecutorRegistry } from "./executor-registry";
export type { ExecutorRegistryOptions } from "./executor-registry";

export { SWARM_TASK_KIND, SwarmJobExecutor, scheduledTurn } from "./swarm-executor";
export type { SwarmJobExecutorOptions } from "./swarm-executor";

export { ScheduledGatewayRuntime } from "./gateway-runtime";
export type {
  ScheduledGatewayRuntimeEvent,
  ScheduledGatewayRuntimeOptions,
  ScheduledGatewayRuntimeStatus,
} from "./gateway-runtime";

export {
  DeliveryReceiptLedger,
  LedgeredDeliverer,
  RECEIPT_LEDGER_GENESIS_SEED,
} from "./receipt-ledger";
export type {
  ReceiptChainVerification,
  ReceiptLedgerLoadReport,
  ReceiptLedgerOptions,
  ReceiptRecord,
  ReceiptTally,
} from "./receipt-ledger";

export { buildSchedulePaneSnapshot } from "./pane-snapshot";
export type { SchedulePaneSnapshot } from "./pane-snapshot";
