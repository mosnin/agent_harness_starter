export { InMemoryMemoryStore, FileMemoryStore, scoreMemory, tokenize } from "./store";
export type { MemoryRecord, MemoryStore, MemorySearchResult } from "./store";
export { InMemorySessionStore, FileSessionStore, scoreSession } from "./session-store";
export type {
  SessionRecord,
  SessionMessage,
  SessionStore,
  SessionSearchResult,
  Summarizer,
} from "./session-store";
export { InvertedIndex, ftsTokenize, FtsIndexError } from "./fts";
export type { FtsDocument, FtsMatch, FtsQueryOptions, InvertedIndexOptions } from "./fts";
export { searchSessionsFts, buildSessionIndex } from "./session-search";
export type { SessionFtsHit } from "./session-search";
export { SessionSummarizer, extractiveSummary, extractFacts } from "./summarizer";
export type { LlmSummarize, ExtractedFact, SessionSummary, SummarizerOptions } from "./summarizer";
export {
  detectContradictions,
  verifyMemoryWrite,
  memoryWriteCalibration,
  GuardedMemoryStore,
} from "./guard";
export type { ContradictionKind, ContradictionFinding, MemoryWriteVerdict, FlaggedWrite } from "./guard";
export {
  parseMarkdownSections,
  loadContextFiles,
  assembleContextPrompt,
  appendMemoryFact,
} from "./context-files";
export type {
  ContextSection,
  ContextFile,
  ContextLoadOptions,
  AssembledContext,
} from "./context-files";
export { seedCorpus, runRecallBench } from "./recall-bench";
export type { RecallBenchReport, RecallQuery } from "./recall-bench";
export {
  normalizeAttribute,
  normalizeValue,
  combineEvidence,
  reconcileBelief,
  DialecticUserModel,
} from "./user-model";
export type {
  BeliefStatus,
  EvidencePolarity,
  BeliefEvidence,
  UserBelief,
  BeliefAssertion,
  DialecticDecision,
  UserModelSnapshot,
  DialecticModelOptions,
} from "./user-model";
export {
  tierCap,
  evidenceId,
  evidenceFromExtractedFact,
  evidenceFromMemoryRecord,
  evidenceFromVerdict,
  EvidenceLedger,
  EVIDENCE_LEDGER_GENESIS,
} from "./belief-evidence";
// `LedgerEntry` is re-exported under an evidence-specific alias because the
// top-level `src/hades/index.ts` star-merges this barrel with `styx/index.ts`,
// which already exports a (different) market `LedgerEntry`.
export type { EvidenceIdInput, LedgerEntry as EvidenceLedgerEntry } from "./belief-evidence";
export {
  ATTRIBUTE_TAXONOMY,
  parseAssertionCandidates,
  attributeOf,
  extractBeliefAssertions,
} from "./belief-extraction";
export type { ParsedAssertionCandidate, ExtractionOptions } from "./belief-extraction";
export { migrateLegacyTraits, UserModelStore, ProfileMemoryBridge } from "./user-model-store";
export type {
  UserModelStoreOptions,
  PersistedProfile,
  SyncOutcome,
  ProfileMemoryBridgeOptions,
} from "./user-model-store";
export { auditUserModel, userModelCalibration } from "./user-model-verifier";
export type {
  BeliefAuditFinding,
  UserModelAuditReport,
  AuditUserModelOptions,
} from "./user-model-verifier";
export { scriptedSessions, runConvergenceBench, USER_MODEL_FILENAME } from "./user-model-bench";
export type { ConvergenceReport } from "./user-model-bench";
