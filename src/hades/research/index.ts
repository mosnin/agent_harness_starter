export {
  TrajectoryRecorder,
  InMemoryTrajectoryStore,
  FileTrajectoryStore,
  toSkillTrajectory,
} from "./recorder";
export type { ToolEvent, TaskTrajectory, GoalTrajectory } from "./recorder";
export { BatchTrajectoryRunner } from "./batch-runner";
export type { GoalRunner, BatchOptions, BatchSummary, BatchFailure } from "./batch-runner";
// The CAPTURE half of the closed learning loop: a completed run's trajectory
// paired with the verification gate's terminal verdict on it. The forge
// (`../skills/forge`) reads this and distils ONLY from `verified`.
export {
  GateJournal,
  JOURNAL_PATH_ENV,
  appendJournal,
  attestGateVerdict,
  classifyGateVerdict,
  gateReportToVerdict,
  isKnownGateVerdict,
  loadJournal,
  realJournalFs,
  resolveJournalPath,
  saveJournal,
  tallyJournal,
  validateJournal,
  validateJournaledRun,
} from "./gate-journal";
export type {
  GateAttestation,
  GateOutcome,
  JournalEntryProblem,
  JournalFs,
  JournalLoad,
  JournalPathResolution,
  JournalTally,
  JournaledRun,
  RawGateVerdict,
} from "./gate-journal";
export { compressTrajectory, toTrainingExample, toJsonl } from "./compression";
export type {
  CompressedStep,
  CompressedTrajectory,
  CompressOptions,
  TrainingExample,
} from "./compression";
