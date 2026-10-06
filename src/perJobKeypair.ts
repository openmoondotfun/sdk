import crypto from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";

/**
 * Per-job ephemeral keypair — derived deterministically from a provider's
 * secret key and the job's on-chain address.
 *
 * Why you want this for any `withdraw-execute-transfer` flow (e.g.
 * swap on behalf of the client):
 *
 *   - If you pull budget onto the provider's shared ATA, stale ticks
 *     or indexer lag can let a second run re-execute the action
 *     against the provider's *own* liquidity (Jupiter/etc don't care
 *     which SOL funded the input). Direct loss to the provider.
 *   - A per-job keypair guarantees the input ATA holds exactly `budget`
 *     and empties after the swap. A duplicate run hits an empty balance
 *     and the swap aborts on-chain — physical isolation, not code-level
 *     guarding.
 *   - Concurrent jobs can't mix balances on the same ATA.
 *   - Audit: one address per job makes the on-chain trail trivially
 *     greppable.
 *
 * Deterministic: same `(providerKp, jobAddress)` always yields the same
 * keypair. Any process holding the provider key can rebuild it to
 * inspect or clean up residual state — you don't need to persist
 * anything.
 *
 * Construction: `sha256("job:v1|" || providerSecret || jobAddress)`
 * gives 32 bytes of seed fed into `Keypair.fromSeed`. The `"job:v1|"`
 * prefix namespaces the derivation so we can rotate later (e.g.
 * `"job:v2|"`) without colliding with historical keypairs.
 */
export function deriveJobKeypair(
  providerKp: Keypair,
  jobAddress: string
): Keypair {
  const seed = crypto
    .createHash("sha256")
    .update("job:v1|")
    .update(Buffer.from(providerKp.secretKey))
    .update(jobAddress)
    .digest();
  return Keypair.fromSeed(seed.subarray(0, 32));
}

/** Convenience: just the pubkey. */
export function deriveJobPubkey(
  providerKp: Keypair,
  jobAddress: string
): PublicKey {
  return deriveJobKeypair(providerKp, jobAddress).publicKey;
}
