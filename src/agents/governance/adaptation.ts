/**
 * Adaptation policies — controlling when and how governance rules evolve.
 *
 * Governance must be able to grow without becoming unpredictable. This module
 * defines the conditions, controls, and review gates that allow governance
 * policies to be safely updated over time.
 *
 * Key concepts:
 *   - AdaptationProposal: a candidate rule change (add, modify, disable, remove)
 *   - AdaptationPolicy: who can propose, who can approve, and what triggers review
 *   - AdaptationLog: immutable record of all governance changes for auditability
 *
 * Usage:
 *   import { createAdaptationPolicy } from "@/agents/governance/adaptation";
 *
 *   const adaptation = createAdaptationPolicy({
 *     requireHumanApproval: true,
 *     allowedProposers: ["governance-agent"],
 *     triggerReviewAfterViolationRate: 0.1,
 *   });
 *
 *   const proposal = {
 *     type: "add",
 *     ruleId: "block-new-tool",
 *     rationale: "New tool introduced last sprint has elevated violation rate.",
 *   };
 *
 *   await adaptation.propose(proposal);
 *   // → queued for human review
 */

import { randomUUID } from "crypto";
import type { GovernanceRule } from "./types";

// ── Proposal types ────────────────────────────────────────────────────────────

export type ProposalType = "add" | "modify" | "disable" | "remove";
export type ProposalStatus = "pending" | "approved" | "rejected" | "applied";

export interface AdaptationProposal {
  id: string;
  type: ProposalType;
  /** ID of the rule being added/modified/disabled/removed. */
  ruleId: string;
  /** The new or replacement rule (required for "add" and "modify"). */
  rule?: GovernanceRule;
  /** Human-readable reason for the change. */
  rationale: string;
  /** The agent or user that submitted the proposal. */
  proposerId: string;
  timestamp: number;
  status: ProposalStatus;
  reviewedBy?: string;
  reviewedAt?: number;
  reviewNote?: string;
}

// ── Adaptation log entry ──────────────────────────────────────────────────────

export interface AdaptationLogEntry {
  id: string;
  proposal: AdaptationProposal;
  appliedAt: number;
  appliedBy: string;
}

// ── Adaptation policy config ──────────────────────────────────────────────────

export interface AdaptationPolicyConfig {
  /**
   * Whether every proposal must be approved by a human before being applied.
   * Default: true.
   */
  requireHumanApproval?: boolean;

  /**
   * Agent IDs that may submit proposals. Wildcard "*" allows any agent.
   * Default: [].
   */
  allowedProposers?: string[];

  /**
   * When the compliance violation rate exceeds this threshold, trigger an
   * automatic governance review notification. Default: 0.15 (15%).
   */
  triggerReviewAfterViolationRate?: number;

  /**
   * Minimum hours between applying two proposals (rate-limit governance
   * changes to prevent rapid instability). Default: 24.
   */
  minHoursBetweenChanges?: number;

  /**
   * Callback for sending review notifications (Slack, email, etc.).
   * Receives the proposal and should route it to a human reviewer.
   */
  notifyReviewer?: (proposal: AdaptationProposal) => Promise<void>;

  /**
   * Callback invoked when a proposal is approved and ready to be applied.
   * Receives the approved proposal and should mutate the live rule set.
   */
  onApply?: (proposal: AdaptationProposal) => void | Promise<void>;
}

export interface AdaptationPolicy {
  /**
   * Submit a proposal. If requireHumanApproval is false and the proposer
   * is allowed, it is immediately applied.
   */
  propose(
    type: ProposalType,
    ruleId: string,
    rationale: string,
    proposerId: string,
    rule?: GovernanceRule
  ): Promise<AdaptationProposal>;

  /**
   * Approve a pending proposal (called by a human reviewer).
   * If onApply is configured, applies the change immediately.
   */
  approve(proposalId: string, reviewerId: string, note?: string): Promise<AdaptationProposal>;

  /**
   * Reject a pending proposal.
   */
  reject(proposalId: string, reviewerId: string, note: string): AdaptationProposal;

  /** Check if the current violation rate should trigger a review. */
  shouldTriggerReview(violationRate: number): boolean;

  /** All proposals. */
  proposals(): AdaptationProposal[];

  /** The applied change log. */
  log(): AdaptationLogEntry[];
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createAdaptationPolicy(
  config: AdaptationPolicyConfig = {}
): AdaptationPolicy {
  const requireApproval = config.requireHumanApproval !== false;
  const allowedProposers = new Set(config.allowedProposers ?? []);
  const minHoursMs = (config.minHoursBetweenChanges ?? 24) * 3_600_000;
  const triggerRate = config.triggerReviewAfterViolationRate ?? 0.15;

  const proposals: AdaptationProposal[] = [];
  const changeLog: AdaptationLogEntry[] = [];
  let lastAppliedAt = 0;

  function canPropose(proposerId: string): boolean {
    return allowedProposers.has("*") || allowedProposers.has(proposerId);
  }

  async function apply(proposal: AdaptationProposal, appliedBy: string): Promise<void> {
    const now = Date.now();
    if (now - lastAppliedAt < minHoursMs && changeLog.length > 0) {
      throw new Error(
        `Governance change rate-limited. Minimum ${config.minHoursBetweenChanges ?? 24}h between changes.`
      );
    }

    proposal.status = "applied";
    lastAppliedAt = now;

    changeLog.push({ id: randomUUID(), proposal, appliedAt: now, appliedBy });

    if (config.onApply) {
      await Promise.resolve(config.onApply(proposal));
    }
  }

  return {
    async propose(type, ruleId, rationale, proposerId, rule) {
      if (!canPropose(proposerId)) {
        throw new Error(`Proposer "${proposerId}" is not authorized to submit governance proposals.`);
      }

      const proposal: AdaptationProposal = {
        id: randomUUID(),
        type,
        ruleId,
        rule,
        rationale,
        proposerId,
        timestamp: Date.now(),
        status: "pending",
      };

      proposals.push(proposal);

      if (!requireApproval) {
        await apply(proposal, proposerId);
      } else if (config.notifyReviewer) {
        await config.notifyReviewer(proposal).catch(() => undefined);
      }

      return proposal;
    },

    async approve(proposalId, reviewerId, note) {
      const proposal = proposals.find((p) => p.id === proposalId);
      if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);
      if (proposal.status !== "pending") {
        throw new Error(`Proposal "${proposalId}" is not pending (status: ${proposal.status}).`);
      }

      proposal.reviewedBy = reviewerId;
      proposal.reviewedAt = Date.now();
      proposal.reviewNote = note;

      await apply(proposal, reviewerId);
      return proposal;
    },

    reject(proposalId, reviewerId, note) {
      const proposal = proposals.find((p) => p.id === proposalId);
      if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);

      proposal.status = "rejected";
      proposal.reviewedBy = reviewerId;
      proposal.reviewedAt = Date.now();
      proposal.reviewNote = note;
      return proposal;
    },

    shouldTriggerReview(violationRate) {
      return violationRate >= triggerRate;
    },

    proposals() {
      return [...proposals];
    },

    log() {
      return [...changeLog];
    },
  };
}
