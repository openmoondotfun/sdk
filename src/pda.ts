import { PublicKey } from "@solana/web3.js";

export const ACP_PROGRAM_ID = new PublicKey(
  "acpftMZyP6rMaVieiaN5KF9k4CouXNcFX7xL9cSd4Pt"
);

export function u64ToLeBytes(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

export function getAcpStatePda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("acp_state")],
    ACP_PROGRAM_ID
  );
  return pda;
}

export function getPdaAgent(agentId: number | bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), u64ToLeBytes(agentId)],
    ACP_PROGRAM_ID
  );
  return pda;
}

export function getJobPda(agentPda: PublicKey, jobId: number | bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("job"), agentPda.toBuffer(), u64ToLeBytes(jobId)],
    ACP_PROGRAM_ID
  );
  return pda;
}

export function getMemoPda(jobPda: PublicKey, memoId: number | bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("memo"), jobPda.toBuffer(), u64ToLeBytes(memoId)],
    ACP_PROGRAM_ID
  );
  return pda;
}

export function getMemoSigPda(
  jobPda: PublicKey,
  memoId: number | bigint,
  signer: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("memo_sig"),
      jobPda.toBuffer(),
      u64ToLeBytes(memoId),
      signer.toBuffer(),
    ],
    ACP_PROGRAM_ID
  );
  return pda;
}

export function getEscrowVaultPda(jobPda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_vault"), jobPda.toBuffer()],
    ACP_PROGRAM_ID
  );
  return pda;
}

export function getEscrowAuthorityPda(jobPda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_auth"), jobPda.toBuffer()],
    ACP_PROGRAM_ID
  );
  return pda;
}

/** PDA authority over an agent's per-mint fee vaults. Per-agent only —
 *  the same authority signs for every (agent, mint) vault. Mirrors the
 *  on-chain seeds in `claim_fee` / `claim_agent_fee`. */
export function getAgentFeeAuthorityPda(agentPda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent_fee_auth"), agentPda.toBuffer()],
    ACP_PROGRAM_ID
  );
  return pda;
}

export function zeroHash(): number[] {
  return new Array(32).fill(0);
}
