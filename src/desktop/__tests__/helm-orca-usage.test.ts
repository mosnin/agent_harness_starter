import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeHelmOrcaUsage, type HelmOrcaUsageObservation } from '../core/helm-orca-usage';
const expected = { dispatchId: 'worker-dispatch', sessionId: 'session' };
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture() {
  const observation: HelmOrcaUsageObservation = {
    provider: 'claude',
    identity: {
      sessionId: 'session',
      runtimeId: 'host',
      dispatchId: 'client-operation',
      acquisitionGeneration: 'acq',
      fence: 7,
      providerSessionId: 'provider',
      turnId: null,
    },
    eventId: 'result',
    scope: 'provider-result',
    aggregation: 'unknown',
    inputTokens: 0,
    outputTokens: 3,
    reportedCostUsd: null,
    reportedTurns: 1,
    cache: { readTokens: null, creationTokens: null, relationToInput: 'unknown' },
    completeness: 'partial',
  };
  return {
    version: 1,
    dispatchId: 'worker-dispatch',
    aggregation: 'unknown',
    state: 'available',
    sessionId: 'session',
    observations: [row(observation)],
    conflict: false,
    truncated: false,
  };
}
function row(observation: HelmOrcaUsageObservation) {
  const i = observation.identity;
  return {
    observation,
    observedAt: 123,
    observationKey: sha([
      observation.provider,
      observation.eventId,
      i.sessionId,
      i.providerSessionId,
      i.dispatchId,
      i.runtimeId,
      i.acquisitionGeneration,
      i.turnId,
    ]),
    payloadHash: sha(observation),
    conflict: false,
  };
}
describe('Orca usage projection decoder', () => {
  it('validates canonical observations without conflating client-operation and worker dispatch', () => {
    const page = fixture();
    const decoded = decodeHelmOrcaUsage(page, expected);
    expect(decoded).toEqual(page);
    if (decoded.state !== 'available') throw new Error('fixture');
    page.observations[0].observation.identity.dispatchId = 'mutated';
    expect(decoded.observations[0].observation.identity.dispatchId).toBe('client-operation');
    expect(decoded.observations[0].observation.inputTokens).toBe(0);
    expect(decoded.observations[0].observation.reportedCostUsd).toBeNull();
  });
  it('canonicalizes transport key order before recomputing hashes', () => {
    const page = fixture();
    page.observations[0].observation = Object.fromEntries(
      Object.entries(page.observations[0].observation).reverse(),
    ) as HelmOrcaUsageObservation;
    expect(decodeHelmOrcaUsage(page, expected).state).toBe('available');
  });
  it('distinguishes missing, unavailable, malformed and wrong authority', () => {
    expect(decodeHelmOrcaUsage(undefined, expected)).toEqual({ state: 'unsupported' });
    expect(decodeHelmOrcaUsage(null, expected).state).toBe('malformed');
    expect(decodeHelmOrcaUsage({ ...fixture(), dispatchId: 'foreign' }, expected).state).toBe(
      'mismatch',
    );
    expect(decodeHelmOrcaUsage({ ...fixture(), sessionId: 'foreign' }, expected).state).toBe(
      'mismatch',
    );
    for (const reason of [
      'identity_unproven',
      'owning_host_required',
      'unsupported_or_unattached',
      'identity_mismatch',
      'journal_unavailable',
    ]) {
      expect(
        decodeHelmOrcaUsage(
          {
            version: 1,
            dispatchId: expected.dispatchId,
            aggregation: 'unknown',
            state: 'unavailable',
            reason,
          },
          expected,
        ),
      ).toEqual({ state: 'unavailable', reason });
    }
  });
  it('rejects all extra fields at each retained level', () => {
    for (const target of ['outer', 'row', 'observation', 'identity', 'cache']) {
      const page = fixture();
      const r = page.observations[0];
      const value =
        target === 'outer'
          ? page
          : target === 'row'
            ? r
            : target === 'observation'
              ? r.observation
              : target === 'identity'
                ? r.observation.identity
                : r.observation.cache;
      Object.assign(value, { apiKey: 'must-not-survive' });
      expect(decodeHelmOrcaUsage(page, expected)).toEqual({
        state: 'malformed',
        reason: 'invalid_projection',
      });
    }
  });
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '4', undefined])(
    'rejects invalid token count %s',
    (value) => {
      const page = fixture();
      Object.assign(page.observations[0].observation, { inputTokens: value });
      expect(decodeHelmOrcaUsage(page, expected).state).toBe('malformed');
    },
  );
  it('rejects forged hashes, timestamps, identifiers, versions and unsupported semantics', () => {
    const mutations = [
      (p: ReturnType<typeof fixture>) => {
        p.version = 2;
      },
      (p: ReturnType<typeof fixture>) => {
        p.observations[0].payloadHash = 'f'.repeat(64);
      },
      (p: ReturnType<typeof fixture>) => {
        p.observations[0].observationKey = 'A'.repeat(64);
      },
      (p: ReturnType<typeof fixture>) => {
        p.observations[0].observedAt = -1;
      },
      (p: ReturnType<typeof fixture>) => {
        p.observations[0].observation.identity.runtimeId = 'x'.repeat(513);
      },
      (p: ReturnType<typeof fixture>) => {
        p.observations[0].observation.reportedCostUsd = Infinity;
      },
      (p: ReturnType<typeof fixture>) => {
        p.aggregation = 'cumulative';
      },
    ];
    for (const mutate of mutations) {
      const p = fixture();
      mutate(p);
      expect(decodeHelmOrcaUsage(p, expected).state).toBe('malformed');
    }
  });
  it('rejects nested foreign sessions even when recomputed hashes agree', () => {
    const p = fixture();
    const o = {
      ...p.observations[0].observation,
      identity: { ...p.observations[0].observation.identity, sessionId: 'foreign' },
    };
    p.observations = [row(o)];
    expect(decodeHelmOrcaUsage(p, expected).state).toBe('mismatch');
  });
  it('bounds rows, rejects duplicates, and preserves conflicts and truncation without totals', () => {
    const p = fixture();
    p.observations = Array(101).fill(p.observations[0]);
    expect(decodeHelmOrcaUsage(p, expected).state).toBe('malformed');
    p.observations = p.observations.slice(0, 2);
    expect(decodeHelmOrcaUsage(p, expected).state).toBe('malformed');
    const c = fixture();
    c.observations.push(row({ ...c.observations[0].observation, inputTokens: 8 }));
    expect(decodeHelmOrcaUsage(c, expected).state).toBe('malformed');
    c.conflict = true;
    c.truncated = true;
    c.observations.forEach((r) => {
      r.conflict = true;
    });
    expect(decodeHelmOrcaUsage(c, expected)).toEqual(c);
    const beyond = fixture();
    beyond.conflict = true;
    beyond.truncated = true;
    expect(decodeHelmOrcaUsage(beyond, expected)).toEqual(beyond);
  });
});
