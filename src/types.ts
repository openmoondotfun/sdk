import type * as anchor from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";

/** A decoded `Job` account (field names as Anchor camel-cases them). */
export interface OnChainJob {
  /** Job number, counted per agent (not unique across agents). */
  id: anchor.BN;
  agent: PublicKey;
  client: PublicKey;
  provider: PublicKey;
  /** `PublicKey.default` when the client evaluates the job themselves. */
  evaluator: PublicKey;
  paymentMint: PublicKey;
  phase: number;
  budget: anchor.BN;
  fee: anchor.BN;
  amountClaimed: anchor.BN;
  amountRefunded: anchor.BN;
  memoCount: anchor.BN;
  /** Unix seconds. */
  expiredAt: anchor.BN;
  /** Set once the provider posts a Deliverable; the job can no longer be
   *  cancelled after expiry, only evaluated. */
  hasDeliverable: boolean;
  /** Set once an Agreement memo exists; budget and fee can't change after. */
  termsLocked: boolean;
}

export interface OnChainMemo {
  memoId: number;
  memoType: string;
  sender: PublicKey;
  /** Phase the job was in when the memo was posted. A JobRequest, Agreement
   *  or Transaction memo can only be signed while the job is still in it. */
  phaseAtCreation: number;
  /** Phase an approving signature moves the job to. */
  nextPhase: number;
  /** Unix seconds. */
  createdAt: number;
}

export const AnchorMemoType: Record<string, any> = {
  jobRequest: { jobRequest: {} },
  agreement: { agreement: {} },
  transaction: { transaction: {} },
  deliverable: { deliverable: {} },
  general: { general: {} },
};

export type MemoTypeName = keyof typeof AnchorMemoType;

export const PHASE_NAMES = [
  "request",
  "negotiation",
  "transaction",
  "evaluation",
  "completed",
  "rejected",
] as const;

export type AcpPhase = (typeof PHASE_NAMES)[number];

export function phaseName(phase: number): AcpPhase {
  return PHASE_NAMES[phase] ?? "request";
}

export function memoTypeName(raw: any): string {
  if (!raw || typeof raw !== "object") return "unknown";
  const key = Object.keys(raw)[0];
  return key ?? "unknown";
}

/** How long the job's evaluator has to judge a Deliverable before the client
 *  may reject it themselves (`EVALUATION_TIMEOUT_SECS` in the program). */
export const EVALUATION_TIMEOUT_SECS = 24 * 60 * 60;
