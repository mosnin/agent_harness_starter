import type { ClaimsService } from "./service";
import type { Claimant, ClaimantType, ClaimStatus } from "./types";

export interface ClaimsToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  execute: (service: ClaimsService, args: Record<string, unknown>) => Promise<unknown>;
}

function toClaimant(args: Record<string, unknown>): Claimant {
  return {
    id: String(args.claimantId ?? args.claimant_id ?? ""),
    type: (args.claimantType ?? args.claimant_type ?? "agent") as ClaimantType,
    name: String(args.claimantName ?? args.claimant_name ?? ""),
    metadata: (args.claimantMetadata as Record<string, unknown> | undefined),
  };
}

export function createClaimsTools(service: ClaimsService): ClaimsToolDefinition[] {
  return [
    {
      name: "claims_create",
      description: "Create a new open claim (task) available for agents or humans to pick up.",
      parameters: {
        title: { type: "string", description: "Short title for the claim.", required: true },
        description: { type: "string", description: "Full description of the work to be done.", required: true },
        priority: { type: "number", description: "Priority 1-10 (default 5)." },
        tags: { type: "array", description: "Optional string tags for filtering." },
        expiresAt: { type: "number", description: "Unix ms timestamp after which the claim auto-expires if unclaimed." },
        stealAfterMs: { type: "number", description: "Mark the claim stealable if active for longer than this many milliseconds." },
        metadata: { type: "object", description: "Arbitrary metadata." },
      },
      async execute(svc, args) {
        return svc.create({
          title: String(args.title),
          description: String(args.description),
          priority: args.priority !== undefined ? Number(args.priority) : undefined,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
          expiresAt: args.expiresAt !== undefined ? Number(args.expiresAt) : undefined,
          stealAfterMs: args.stealAfterMs !== undefined ? Number(args.stealAfterMs) : undefined,
          metadata: args.metadata as Record<string, unknown> | undefined,
        });
      },
    },

    {
      name: "claims_list",
      description: "List claims, optionally filtered by status, claimant, tag, or minimum priority.",
      parameters: {
        status: { type: "string | string[]", description: "Filter by status or array of statuses." },
        claimantId: { type: "string", description: "Filter to claims held by this claimant ID." },
        tag: { type: "string", description: "Filter to claims with this tag." },
        minPriority: { type: "number", description: "Filter to claims with priority >= this value." },
      },
      async execute(svc, args) {
        return svc.list({
          status: args.status as ClaimStatus | ClaimStatus[] | undefined,
          claimantId: args.claimantId !== undefined ? String(args.claimantId) : undefined,
          tag: args.tag !== undefined ? String(args.tag) : undefined,
          minPriority: args.minPriority !== undefined ? Number(args.minPriority) : undefined,
        });
      },
    },

    {
      name: "claims_claim",
      description: "Assign an open claim to a claimant (human, agent, or system). Transitions open → claimed.",
      parameters: {
        claimId: { type: "string", description: "ID of the claim to assign.", required: true },
        claimantId: { type: "string", description: "Unique ID of the claimant.", required: true },
        claimantType: { type: "string", description: "Type of claimant: 'human', 'agent', or 'system'.", required: true },
        claimantName: { type: "string", description: "Display name of the claimant.", required: true },
        claimantMetadata: { type: "object", description: "Optional metadata about the claimant." },
      },
      async execute(svc, args) {
        return svc.claim(String(args.claimId), toClaimant(args));
      },
    },

    {
      name: "claims_start",
      description: "Begin work on a claimed task. Transitions claimed → active.",
      parameters: {
        claimId: { type: "string", description: "ID of the claim to start.", required: true },
      },
      async execute(svc, args) {
        return svc.start(String(args.claimId));
      },
    },

    {
      name: "claims_complete",
      description: "Mark an active claim as completed with an optional result payload. Transitions active → completed.",
      parameters: {
        claimId: { type: "string", description: "ID of the claim to complete.", required: true },
        result: { type: "unknown", description: "Optional result payload to attach to the claim." },
      },
      async execute(svc, args) {
        return svc.complete(String(args.claimId), args.result);
      },
    },

    {
      name: "claims_fail",
      description: "Mark a claim as failed with an error message. Transitions active/paused/blocked → failed.",
      parameters: {
        claimId: { type: "string", description: "ID of the claim to fail.", required: true },
        error: { type: "string", description: "Error message describing the failure.", required: true },
      },
      async execute(svc, args) {
        return svc.fail(String(args.claimId), String(args.error));
      },
    },

    {
      name: "claims_steal",
      description: "Steal a stealable (inactive too long) claim and reassign it to a new claimant. Transitions stealable → claimed.",
      parameters: {
        claimId: { type: "string", description: "ID of the stealable claim.", required: true },
        claimantId: { type: "string", description: "Unique ID of the new claimant.", required: true },
        claimantType: { type: "string", description: "Type of new claimant: 'human', 'agent', or 'system'.", required: true },
        claimantName: { type: "string", description: "Display name of the new claimant.", required: true },
        claimantMetadata: { type: "object", description: "Optional metadata about the new claimant." },
      },
      async execute(svc, args) {
        return svc.steal(String(args.claimId), toClaimant(args));
      },
    },

    {
      name: "claims_stats",
      description: "Get aggregate statistics about all claims: counts by status, average completion time, and steal count.",
      parameters: {},
      async execute(svc, _args) {
        return svc.getStats();
      },
    },
  ];
}
