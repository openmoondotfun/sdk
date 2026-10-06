import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";

import { hashContent } from "./crypto";
import {
  getAcpStatePda,
  getAgentFeeAuthorityPda,
  getEscrowAuthorityPda,
  getEscrowVaultPda,
  getMemoPda,
  getMemoSigPda,
  zeroHash,
} from "./pda";
import { loadAcpIdl } from "./idl";
import {
  AnchorMemoType,
  MemoTypeName,
  OnChainJob,
  OnChainMemo,
  memoTypeName,
  phaseName,
} from "./types";

const NATIVE_MINT_STR = "So11111111111111111111111111111111111111112";

export interface AcpClientOptions {
  connection: Connection;
  keypair: Keypair;
  /** Optional pre-loaded IDL. If omitted, the bundled IDL is used. */
  idl?: any;
  /** Extra filesystem paths to search when loading the bundled IDL. */
  idlCandidates?: string[];
  /** Anchor commitment level. Defaults to "confirmed". */
  commitment?: anchor.web3.Commitment;
}

/**
 * Thin wrapper around an Anchor `Program` for the ACP contract. One instance
 * per signing keypair — pooling / multi-agent caching is the caller's job.
 */
export class AcpClient {
  readonly connection: Connection;
  readonly keypair: Keypair;
  readonly program: anchor.Program;

  constructor(opts: AcpClientOptions) {
    this.connection = opts.connection;
    this.keypair = opts.keypair;
    const wallet = new anchor.Wallet(opts.keypair);
    const provider = new anchor.AnchorProvider(opts.connection, wallet, {
      commitment: opts.commitment ?? "confirmed",
    });
    const idl = opts.idl ?? loadAcpIdl(opts.idlCandidates);
    this.program = new anchor.Program(idl as anchor.Idl, provider);
  }

  // ─── Reads ────────────────────────────────────────────────────────

  async fetchJob(jobAddress: string | PublicKey): Promise<OnChainJob> {
    const pda = typeof jobAddress === "string" ? new PublicKey(jobAddress) : jobAddress;
    return (this.program.account as any).job.fetch(pda);
  }

  async fetchAcpState(): Promise<any> {
    return (this.program.account as any).acpState.fetch(getAcpStatePda());
  }

  /** Walk memos 1..memoCount by PDA and batch-fetch their accounts. */
  async listJobMemos(
    jobAddress: string | PublicKey,
    memoCount: number
  ): Promise<OnChainMemo[]> {
    if (memoCount <= 0) return [];
    const jobPda = typeof jobAddress === "string" ? new PublicKey(jobAddress) : jobAddress;
    const pdas = Array.from({ length: memoCount }, (_, i) =>
      getMemoPda(jobPda, i + 1)
    );
    const accounts = await (this.program.account as any).memo.fetchMultiple(pdas);
    const out: OnChainMemo[] = [];
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      if (!acc) continue;
      out.push({
        memoId: i + 1,
        memoType: memoTypeName(acc.memoType),
        sender: acc.sender,
        phaseAtCreation: acc.phaseAtCreation,
        nextPhase: acc.nextPhase,
        createdAt: Number(acc.createdAt),
      });
    }
    return out;
  }

  // ─── Writes ───────────────────────────────────────────────────────

  /** Sign the job's JobRequest memo with approved/rejected. */
  async acceptOrRejectJob(
    jobAddress: string | PublicKey,
    opts: { accept: boolean; reason?: string }
  ): Promise<{ tx: string }> {
    const jobPda = typeof jobAddress === "string" ? new PublicKey(jobAddress) : jobAddress;
    const job = await this.fetchJob(jobPda);

    // Clients post the JobRequest first, but a General memo may come before it.
    const memos = await this.listJobMemos(jobPda, Number(job.memoCount));
    const jobRequest = memos.find((m) => m.memoType === "jobRequest");
    if (!jobRequest) throw new Error("No JobRequest memo to sign");
    const memoId = jobRequest.memoId;
    const memoSigPda = getMemoSigPda(jobPda, BigInt(memoId), this.keypair.publicKey);
    const reasonHash = opts.reason ? hashContent(opts.reason) : zeroHash();

    const tx = await (this.program.methods as any)
      .signMemo(opts.accept, reasonHash)
      .accounts({
        signer: this.keypair.publicKey,
        acpState: getAcpStatePda(),
        agent: job.agent,
        job: jobPda,
        memo: getMemoPda(jobPda, memoId),
        memoSignature: memoSigPda,
        escrowVault: getEscrowVaultPda(jobPda),
        systemProgram: SystemProgram.programId,
      })
      .signers([this.keypair])
      .rpc();

    return { tx };
  }

  /** Sign an arbitrary memo by id (ack Transaction, Deliverable, etc). */
  async signMemoById(
    jobAddress: string | PublicKey,
    memoId: number,
    approve: boolean
  ): Promise<{ tx: string }> {
    const jobPda = typeof jobAddress === "string" ? new PublicKey(jobAddress) : jobAddress;
    const job = await this.fetchJob(jobPda);
    const memoSigPda = getMemoSigPda(jobPda, BigInt(memoId), this.keypair.publicKey);

    const tx = await (this.program.methods as any)
      .signMemo(approve, zeroHash())
      .accounts({
        signer: this.keypair.publicKey,
        acpState: getAcpStatePda(),
        agent: job.agent,
        job: jobPda,
        memo: getMemoPda(jobPda, memoId),
        memoSignature: memoSigPda,
        escrowVault: getEscrowVaultPda(jobPda),
        systemProgram: SystemProgram.programId,
      })
      .signers([this.keypair])
      .rpc();

    return { tx };
  }

  async setBudget(
    jobAddress: string | PublicKey,
    budget: number | bigint,
    fee: number | bigint
  ): Promise<{ tx: string }> {
    const jobPda = typeof jobAddress === "string" ? new PublicKey(jobAddress) : jobAddress;
    const job = await this.fetchJob(jobPda);

    const tx = await (this.program.methods as any)
      .setBudget(
        new anchor.BN(budget.toString()),
        new anchor.BN(fee.toString())
      )
      .accounts({
        provider: this.keypair.publicKey,
        agent: job.agent,
        job: jobPda,
      })
      .signers([this.keypair])
      .rpc();
    return { tx };
  }

  /** Create a memo of the given type. Returns the assigned memoId. */
  async createMemo(
    jobAddress: string | PublicKey,
    memoType: MemoTypeName,
    content: string
  ): Promise<{ memoId: number; tx: string }> {
    const jobPda = typeof jobAddress === "string" ? new PublicKey(jobAddress) : jobAddress;
    const job = await this.fetchJob(jobPda);
    const nextMemoId = Number(job.memoCount) + 1;
    const memoPda = getMemoPda(jobPda, nextMemoId);

    const anchorType = AnchorMemoType[memoType];
    if (!anchorType) throw new Error(`Invalid memoType: ${memoType}`);

    const tx = await (this.program.methods as any)
      .createMemo(hashContent(content), anchorType, false)
      .accounts({
        sender: this.keypair.publicKey,
        agent: job.agent,
        job: jobPda,
        memo: memoPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.keypair])
      .rpc();

    return { memoId: nextMemoId, tx };
  }

  /** Pull funds from escrow into provider's ATA. */
  async withdrawBudget(
    jobAddress: string | PublicKey
  ): Promise<{
    tx: string;
    amountLamports: bigint;
    paymentMint: PublicKey;
    clientWallet: PublicKey;
  } | null> {
    const jobPda = typeof jobAddress === "string" ? new PublicKey(jobAddress) : jobAddress;
    const job = await this.fetchJob(jobPda);

    const claimable =
      BigInt(job.budget.toString()) - BigInt(job.amountClaimed.toString());
    if (claimable <= 0n) return null;

    const escrowVault = getEscrowVaultPda(jobPda);
    const escrowInfo = await this.connection.getAccountInfo(escrowVault);
    if (!escrowInfo) return null;
    const escrowBalance = Buffer.from(escrowInfo.data).readBigUInt64LE(64);
    if (escrowBalance === 0n) return null;

    const escrowAuthority = getEscrowAuthorityPda(jobPda);
    const paymentMint = job.paymentMint;
    const providerAta = getAssociatedTokenAddressSync(
      paymentMint,
      this.keypair.publicKey
    );

    const createProviderAta = createAssociatedTokenAccountIdempotentInstruction(
      this.keypair.publicKey,
      providerAta,
      this.keypair.publicKey,
      paymentMint
    );

    const tx = await (this.program.methods as any)
      .claimBudget(new anchor.BN(claimable.toString()))
      .accounts({
        provider: this.keypair.publicKey,
        agent: job.agent,
        job: jobPda,
        escrowVault,
        escrowAuthority,
        providerTokenAccount: providerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([createProviderAta])
      .signers([this.keypair])
      .rpc();

    return {
      tx,
      amountLamports: claimable,
      paymentMint,
      clientWallet: job.client,
    };
  }

  /** Return previously-withdrawn principal from the provider's ATA back
   *  into the job's escrow vault. Records the return on-chain via
   *  `job.amount_refunded` + emits `RefundedToEscrow` — designed for the
   *  failure path of `withdraw → execute → transfer` offerings so the
   *  client's eventual `claim_fee` on REJECTED sweeps everything home.
   *
   *  Returns `null` when there's nothing left to refund (provider didn't
   *  withdraw, or already refunded in full). Caps `amount` at the
   *  outstanding balance so callers can safely pass whatever they
   *  withdrew without having to re-query `amount_refunded` first. */
  async refundBudget(
    jobAddress: string | PublicKey,
    amount: bigint
  ): Promise<{
    tx: string;
    amountLamports: bigint;
  } | null> {
    if (amount <= 0n) return null;
    const jobPda = typeof jobAddress === "string" ? new PublicKey(jobAddress) : jobAddress;
    const job = await this.fetchJob(jobPda);

    const claimed = BigInt(job.amountClaimed.toString());
    const refunded = BigInt((job as any).amountRefunded?.toString?.() ?? "0");
    const outstanding = claimed - refunded;
    if (outstanding <= 0n) return null;
    const effective = amount > outstanding ? outstanding : amount;

    const escrowVault = getEscrowVaultPda(jobPda);
    const paymentMint = job.paymentMint;
    const providerAta = getAssociatedTokenAddressSync(
      paymentMint,
      this.keypair.publicKey
    );

    const tx = await (this.program.methods as any)
      .refundBudget(new anchor.BN(effective.toString()))
      .accounts({
        provider: this.keypair.publicKey,
        agent: job.agent,
        job: jobPda,
        escrowVault,
        providerTokenAccount: providerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([this.keypair])
      .rpc();

    return { tx, amountLamports: effective };
  }

  /** Settle a finished job's escrow (signer: the client or the provider).
   *  COMPLETED: pays out the fee — the platform's `platform_fee_bps` share to
   *  its treasury, the rest to the agent's fee vault (see `claimAgentFee`).
   *  REJECTED: returns everything left in escrow to the client's token
   *  account (wSOL stays wrapped). Skipped when there's nothing to move;
   *  throws in any other phase, which may just be an RPC behind the job. */
  async claimFee(
    jobAddress: string | PublicKey
  ): Promise<{ tx: string | null; skipped?: boolean }> {
    const jobPda = typeof jobAddress === "string" ? new PublicKey(jobAddress) : jobAddress;
    const job = await this.fetchJob(jobPda);

    const phase = phaseName(job.phase);
    if (phase === "completed") {
      if (BigInt(job.fee.toString()) <= 0n) return { tx: null, skipped: true };
    } else if (phase === "rejected") {
      const escrowInfo = await this.connection.getAccountInfo(getEscrowVaultPda(jobPda));
      if (!escrowInfo || Buffer.from(escrowInfo.data).readBigUInt64LE(64) === 0n) {
        return { tx: null, skipped: true };
      }
    } else {
      throw new Error(`claim_fee needs a completed or rejected job (phase: ${phase})`);
    }

    const acpStatePda = getAcpStatePda();
    const acpState = await this.fetchAcpState();
    // `acpState.platformTreasury` stores the treasury ATA directly (set by
    // `initialize_acp` via associated_token). Passing it through
    // `getAssociatedTokenAddressSync` again derives an ATA-of-ATA that
    // doesn't exist — contract returns AccountNotInitialized (#3012).
    const platformTreasuryAta: PublicKey = acpState.platformTreasury;
    const paymentMint = job.paymentMint;

    const escrowVault = getEscrowVaultPda(jobPda);
    const escrowAuthority = getEscrowAuthorityPda(jobPda);
    const clientAta = getAssociatedTokenAddressSync(paymentMint, job.client);
    // Agent's slice of the fee parks here on COMPLETED — per-(agent, mint)
    // ATA, lazily created by `claim_fee` on first hit. Authority is per-
    // agent so the same PDA signs across every mint the agent earns in.
    const agentFeeAuthority = getAgentFeeAuthorityPda(job.agent);
    const agentFeeVault = getAssociatedTokenAddressSync(
      paymentMint,
      agentFeeAuthority,
      true
    );

    // Contract requires `client_token_account` as an initialized TokenAccount
    // even on the COMPLETED path (where it isn't actually written to). If the
    // client never held this mint, the ATA doesn't exist → AccountNotInitialized.
    // Create it idempotently so the claim succeeds — but only when the mint
    // itself is a valid SPL Token mint. Legacy jobs with a stale on-chain
    // layout deserialize `payment_mint` to garbage; trying to create an ATA
    // for a non-Mint account fails with `IncorrectProgramId` from the ATA
    // program, masking the real "this job is broken" error from `claim_fee`.
    const preIxs: anchor.web3.TransactionInstruction[] = [];
    const [clientAtaInfo, mintInfo] = await Promise.all([
      this.connection.getAccountInfo(clientAta),
      this.connection.getAccountInfo(paymentMint),
    ]);
    const mintOwnedByTokenProg =
      !!mintInfo && mintInfo.owner.equals(TOKEN_PROGRAM_ID);
    if (!clientAtaInfo && mintOwnedByTokenProg) {
      preIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          this.keypair.publicKey,
          clientAta,
          job.client,
          paymentMint
        )
      );
    }

    const builder = (this.program.methods as any)
      .claimFee()
      .accounts({
        claimer: this.keypair.publicKey,
        acpState: acpStatePda,
        agent: job.agent,
        job: jobPda,
        escrowVault,
        escrowAuthority,
        clientTokenAccount: clientAta,
        platformTreasuryTokenAccount: platformTreasuryAta,
        paymentMint,
        agentFeeAuthority,
        agentFeeVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.keypair]);

    if (preIxs.length > 0) builder.preInstructions(preIxs);
    const tx = await builder.rpc();

    return { tx };
  }

  /** Drain accumulated fees from the agent's per-mint vault into the
   *  signer's ATA. Signer must be the agent's `creator`; otherwise the
   *  contract returns `Unauthorized`. Returns `{tx:null, skipped:true}`
   *  when the vault is empty so the caller can handle that as a no-op. */
  async claimAgentFee(
    agentPda: string | PublicKey,
    paymentMint: string | PublicKey
  ): Promise<{ tx: string | null; skipped?: boolean; amount?: bigint }> {
    const agent = typeof agentPda === "string" ? new PublicKey(agentPda) : agentPda;
    const mint = typeof paymentMint === "string" ? new PublicKey(paymentMint) : paymentMint;

    const agentFeeAuthority = getAgentFeeAuthorityPda(agent);
    const agentFeeVault = getAssociatedTokenAddressSync(mint, agentFeeAuthority, true);

    // Bail when there's nothing to claim — saves gas and avoids the
    // contract's `NoFeeToClaim` error noise in logs.
    let amount = 0n;
    const vaultInfo = await this.connection.getAccountInfo(agentFeeVault);
    if (vaultInfo) {
      amount = vaultInfo.data.readBigUInt64LE(64);
    }
    if (amount <= 0n) return { tx: null, skipped: true };

    const creatorAta = getAssociatedTokenAddressSync(mint, this.keypair.publicKey);

    const tx = await (this.program.methods as any)
      .claimAgentFee()
      .accounts({
        creator: this.keypair.publicKey,
        agent,
        paymentMint: mint,
        agentFeeAuthority,
        agentFeeVault,
        creatorTokenAccount: creatorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.keypair])
      .rpc();

    return { tx, amount };
  }

  /**
   * Transfer SPL or native SOL from the signer to a destination wallet. If
   * `closeSourceAta=true`, uses the actual ATA balance (not the passed
   * amount — Jupiter slippage etc. makes the quoted amount unreliable) and
   * appends a CloseAccount ix to reclaim rent.
   */
  async transferToken(
    mint: PublicKey,
    destinationWallet: PublicKey,
    amount: number | bigint,
    closeSourceAta = false
  ): Promise<string> {
    const tx = new Transaction();

    if (mint.toBase58() === NATIVE_MINT_STR) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: this.keypair.publicKey,
          toPubkey: destinationWallet,
          lamports: BigInt(amount),
        })
      );
    } else {
      const sourceAta = getAssociatedTokenAddressSync(mint, this.keypair.publicKey);
      const destAta = getAssociatedTokenAddressSync(mint, destinationWallet);

      let transferAmount = BigInt(amount);
      if (closeSourceAta) {
        try {
          const bal = await this.connection.getTokenAccountBalance(
            sourceAta,
            "confirmed"
          );
          transferAmount = BigInt(bal.value.amount);
        } catch {
          /* ATA might not exist yet */
        }
      }

      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          this.keypair.publicKey,
          destAta,
          destinationWallet,
          mint
        ),
        createTransferInstruction(
          sourceAta,
          destAta,
          this.keypair.publicKey,
          transferAmount
        )
      );

      if (closeSourceAta) {
        tx.add(
          createCloseAccountInstruction(
            sourceAta,
            this.keypair.publicKey,
            this.keypair.publicKey
          )
        );
      }
    }

    tx.feePayer = this.keypair.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
    tx.sign(this.keypair);

    const sig = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: "confirmed",
    });
    await this.connection.confirmTransaction(sig, "confirmed");
    return sig;
  }
}
