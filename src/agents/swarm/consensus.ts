export interface Vote {
  agentId: string;
  value: unknown;
  weight: number;   // agent's trust weight (default 1.0)
  timestamp: number;
}

export interface ConsensusResult<T> {
  value: T;
  confidence: number;   // fraction of weighted votes agreeing
  totalVotes: number;
  agreement: boolean;   // true if confidence >= quorum
}

/**
 * Majority vote — returns the value with highest weighted count.
 * Groups votes by JSON.stringify(value), sums weights per group, picks highest.
 * confidence = highest weight sum / total weight.
 * agreement = confidence >= quorum (default 0.51).
 */
export function majorityVote<T>(votes: Vote[], quorum = 0.51): ConsensusResult<T> {
  if (votes.length === 0) {
    throw new Error("Cannot compute majority vote with zero votes");
  }

  const weightsByKey = new Map<string, { value: unknown; totalWeight: number }>();
  let totalWeight = 0;

  for (const vote of votes) {
    const key = JSON.stringify(vote.value);
    const existing = weightsByKey.get(key);
    if (existing) {
      existing.totalWeight += vote.weight;
    } else {
      weightsByKey.set(key, { value: vote.value, totalWeight: vote.weight });
    }
    totalWeight += vote.weight;
  }

  let winnerKey = "";
  let winnerWeight = -Infinity;
  for (const [key, entry] of weightsByKey) {
    if (entry.totalWeight > winnerWeight) {
      winnerWeight = entry.totalWeight;
      winnerKey = key;
    }
  }

  const winner = weightsByKey.get(winnerKey)!;
  const confidence = totalWeight > 0 ? winnerWeight / totalWeight : 0;

  return {
    value: winner.value as T,
    confidence,
    totalVotes: votes.length,
    agreement: confidence >= quorum,
  };
}

/**
 * Weighted average for numeric values.
 * Returns the weighted mean of all numeric vote values.
 */
export function weightedAverage(votes: Vote[]): ConsensusResult<number> {
  if (votes.length === 0) {
    throw new Error("Cannot compute weighted average with zero votes");
  }

  let totalWeight = 0;
  let weightedSum = 0;

  for (const vote of votes) {
    const num = vote.value as number;
    weightedSum += num * vote.weight;
    totalWeight += vote.weight;
  }

  const value = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // Confidence: fraction of total weight that falls within 1 std-dev of mean
  // For simplicity: proportion of votes within 10% of the mean, weighted
  let agreementWeight = 0;
  const tolerance = Math.abs(value) * 0.1 + Number.EPSILON;
  for (const vote of votes) {
    const num = vote.value as number;
    if (Math.abs(num - value) <= tolerance) {
      agreementWeight += vote.weight;
    }
  }

  const confidence = totalWeight > 0 ? agreementWeight / totalWeight : 0;

  return {
    value,
    confidence,
    totalVotes: votes.length,
    agreement: confidence >= 0.51,
  };
}
