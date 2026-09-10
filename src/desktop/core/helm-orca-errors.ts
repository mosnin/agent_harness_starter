/** A local admission failure proven to occur before any Orca process or RPC effect. */
export class HelmOrcaPreflightError extends Error {
  override name = 'HelmOrcaPreflightError';
}
