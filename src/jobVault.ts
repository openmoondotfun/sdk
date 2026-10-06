/**
 * Per-job ephemeral wallet plumbing for `withdraw-execute-transfer`
 * offerings. Use instead of `AcpClient.withdrawBudget` when the
 * offering spends the escrow budget on an external protocol (Jupiter
 * swap, stake, etc.).
 *
 * The `acp-core` version is `AcpClient`-parameterised so every consumer
 * (moonagent, acp-template, bespoke providers) can drop straight in
 * with their existing client instance.
 *
 *   import { AcpClient, withdrawBudgetToJobKeypair, … } from "acp-core";
 *
 *   const vault = await withdrawBudgetToJobKeypair(client, jobAddress);
 *   if (!vault) return; // already claimed — bail, don't re-execute
 *   try {
 *     // run your external action with `vault.keypair` as signer
 *     const sig = await transferFromJobKeypair(client, vault.keypair,
 *       outputMint, clientWallet, outAmount, true);
 *   } catch (e) {
 *     // restore client escrow:
 *     //   SPL → transferFromJobKeypair back to provider ATA, then refundBudget
 *     //   SOL → returnNativeSolToProviderWsol, then refundBudget
 *   } finally {
 *     await cleanupJobKeypair(client, jobAddress, [outputMint]);
 *   }
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  TransactionInstruction,
  Connection,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { AcpClient } from "./client";
import {
  getEscrowVaultPda,
  getEscrowAuthorityPda,
} from "./pda";
import { deriveJobKeypair } from "./perJobKeypair";

/** Native-SOL float deposited onto the job keypair so it can pay its
 *  own tx fees on the downstream swap / transfer / close txs. 0.003 SOL
 *  covers a Jupiter swap (priority-fee inclusive), an SPL transfer,
 *  and 2× closeAccount. Surplus is swept back in `cleanupJobKeypair`. */
export const JOB_VAULT_GAS_FLOAT_LAMPORTS = 3_000_000;

export interface JobVaultHandle {
  /** Ephemeral keypair owning the per-job ATAs. Use it as the signer
   *  for swap / transfer / close txs downstream. */
  keypair: Keypair;
  /** Amount successfully claimed out of escrow, in payment-mint lamports. */
  amountLamports: bigint;
  /** Payment token for this job (matches `job.paymentMint`). */
  paymentMint: PublicKey;
  /** Client wallet pubkey — convenience for the caller's transfer step. */
  clientWallet: PublicKey;
  /** `true` iff `paymentMint === NATIVE_MINT`. When true, the claimed
   *  balance lives on the keypair as native SOL (we unwrapped it so
   *  Jupiter's `wrapAndUnwrapSol` expectations are met). */
  nativeSol: boolean;
  /** PDA of `paymentMint` ATA under the job keypair. Populated only
   *  when `nativeSol === false` — for native-SOL jobs this account was
   *  closed as part of the setup tx. */
  inputAta: PublicKey | null;
}

/**
 * Resolve which token program owns `mint`. Newer projects ship under
 * Token-2022 and Jupiter happily creates ATAs there; deriving with the
 * classic `TOKEN_PROGRAM_ID` against such a mint yields a non-existent
 * address. Cache by mint to keep the per-tick RPC budget flat.
 */
const TOKEN_PROGRAM_CACHE = new Map<string, PublicKey>();

export async function getTokenProgramForMint(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  const key = mint.toBase58();
  const cached = TOKEN_PROGRAM_CACHE.get(key);
  if (cached) return cached;
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) {
    // No mint on chain — caller is about to fail anyway. Default to
    // classic so the resulting error message names the legacy ATA.
    return TOKEN_PROGRAM_ID;
  }
  const program = info.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  TOKEN_PROGRAM_CACHE.set(key, program);
  return program;
}

async function fetchJobMinimal(
  client: AcpClient,
  jobPda: PublicKey
): Promise<{
  agent: PublicKey;
  budget: bigint;
  amountClaimed: bigint;
  paymentMint: PublicKey;
  client: PublicKey;
}> {
  const job: any = await (client.program.account as any).job.fetch(jobPda);
  return {
    agent: job.agent,
    budget: BigInt(job.budget.toString()),
    amountClaimed: BigInt(job.amountClaimed.toString()),
    paymentMint: job.paymentMint,
    client: job.client,
  };
}

function connectionOf(client: AcpClient): Connection {
  return client.connection;
}

/**
 * Claim escrow budget into a per-job ephemeral keypair's ATA (or as
 * native SOL on that keypair for SOL-denominated jobs). Returns `null`
 * when the budget was already claimed — callers should treat this as
 * "previous run handled this job" and bail out.
 */
export async function withdrawBudgetToJobKeypair(
  client: AcpClient,
  jobAddress: string | PublicKey
): Promise<JobVaultHandle | null> {
  const connection = connectionOf(client);
  const providerKp = client.keypair;
  const jobPda =
    typeof jobAddress === "string" ? new PublicKey(jobAddress) : jobAddress;
  const jobAddressStr = jobPda.toBase58();

  const job = await fetchJobMinimal(client, jobPda);

  const claimable = job.budget - job.amountClaimed;
  if (claimable <= 0n) return null;

  const escrowVault = getEscrowVaultPda(jobPda);
  const escrowInfo = await connection.getAccountInfo(escrowVault);
  if (!escrowInfo) return null;
  const escrowBalance = Buffer.from(escrowInfo.data).readBigUInt64LE(64);
  if (escrowBalance === 0n) return null;

  const jobKp = deriveJobKeypair(providerKp, jobAddressStr);
  const paymentMint = job.paymentMint;
  const nativeSol = paymentMint.equals(NATIVE_MINT);

  const providerAta = getAssociatedTokenAddressSync(
    paymentMint,
    providerKp.publicKey
  );
  const jobAta = getAssociatedTokenAddressSync(paymentMint, jobKp.publicKey);
  const escrowAuthority = getEscrowAuthorityPda(jobPda);

  const ixs: TransactionInstruction[] = [];

  ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));

  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      providerKp.publicKey,
      providerAta,
      providerKp.publicKey,
      paymentMint
    )
  );

  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      providerKp.publicKey,
      jobAta,
      jobKp.publicKey,
      paymentMint
    )
  );

  const claimBudgetIx: TransactionInstruction = await (
    client.program.methods as any
  )
    .claimBudget(new anchor.BN(claimable.toString()))
    .accounts({
      provider: providerKp.publicKey,
      agent: job.agent,
      job: jobPda,
      escrowVault,
      escrowAuthority,
      providerTokenAccount: providerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  ixs.push(claimBudgetIx);

  ixs.push(
    createTransferInstruction(
      providerAta,
      jobAta,
      providerKp.publicKey,
      claimable
    )
  );

  if (nativeSol) {
    ixs.push(
      createCloseAccountInstruction(jobAta, jobKp.publicKey, jobKp.publicKey)
    );
  }

  ixs.push(
    SystemProgram.transfer({
      fromPubkey: providerKp.publicKey,
      toPubkey: jobKp.publicKey,
      lamports: JOB_VAULT_GAS_FLOAT_LAMPORTS,
    })
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const tx = new Transaction({
    feePayer: providerKp.publicKey,
    blockhash,
    lastValidBlockHeight,
  });
  for (const ix of ixs) tx.add(ix);
  // `closeAccount` for the SOL-unwrap step names `jobKp` as the
  // authority, so the tx needs its signature too. Non-SOL jobs don't
  // include that ix, so providerKp alone is enough.
  if (nativeSol) {
    tx.sign(providerKp, jobKp);
  } else {
    tx.sign(providerKp);
  }

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const res = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (res.value.err) {
    throw new Error(
      `withdrawBudgetToJobKeypair tx failed: ${JSON.stringify(res.value.err)}`
    );
  }

  return {
    keypair: jobKp,
    amountLamports: claimable,
    paymentMint,
    clientWallet: job.client,
    nativeSol,
    inputAta: nativeSol ? null : jobAta,
  };
}

/**
 * Transfer a token (or native SOL) from the per-job keypair to a
 * destination wallet. Signs with `jobKp`.
 */
export async function transferFromJobKeypair(
  client: AcpClient,
  jobKp: Keypair,
  mint: PublicKey,
  destinationWallet: PublicKey,
  amount: bigint,
  closeSourceAta = false
): Promise<string> {
  const connection = connectionOf(client);
  const ixs: TransactionInstruction[] = [];

  if (mint.equals(NATIVE_MINT)) {
    ixs.push(
      SystemProgram.transfer({
        fromPubkey: jobKp.publicKey,
        toPubkey: destinationWallet,
        lamports: amount,
      })
    );
  } else {
    const tokenProgram = await getTokenProgramForMint(connection, mint);
    const sourceAta = getAssociatedTokenAddressSync(
      mint,
      jobKp.publicKey,
      false,
      tokenProgram
    );
    const destAta = getAssociatedTokenAddressSync(
      mint,
      destinationWallet,
      false,
      tokenProgram
    );

    let transferAmount = amount;
    if (closeSourceAta) {
      try {
        const bal = await connection.getTokenAccountBalance(
          sourceAta,
          "confirmed"
        );
        transferAmount = BigInt(bal.value.amount);
      } catch {
        /* ATA might not exist yet */
      }
    }

    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        jobKp.publicKey,
        destAta,
        destinationWallet,
        mint,
        tokenProgram
      ),
      createTransferInstruction(
        sourceAta,
        destAta,
        jobKp.publicKey,
        transferAmount,
        undefined,
        tokenProgram
      )
    );

    if (closeSourceAta) {
      ixs.push(
        createCloseAccountInstruction(
          sourceAta,
          jobKp.publicKey,
          jobKp.publicKey,
          undefined,
          tokenProgram
        )
      );
    }
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const tx = new Transaction({
    feePayer: jobKp.publicKey,
    blockhash,
    lastValidBlockHeight,
  });
  for (const ix of ixs) tx.add(ix);
  tx.sign(jobKp);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const res = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (res.value.err) {
    throw new Error(
      `transferFromJobKeypair tx failed: ${JSON.stringify(res.value.err)}`
    );
  }
  return sig;
}

/**
 * Re-wrap a native-SOL budget back into the provider's wSOL ATA so a
 * subsequent `refund_budget` has something to push into escrow. Needed
 * only on the error path of SOL-denominated jobs.
 */
export async function returnNativeSolToProviderWsol(
  client: AcpClient,
  jobKp: Keypair,
  amount: bigint
): Promise<string> {
  const connection = connectionOf(client);
  const providerKp = client.keypair;
  const providerWsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    providerKp.publicKey
  );

  const ixs: TransactionInstruction[] = [
    SystemProgram.transfer({
      fromPubkey: jobKp.publicKey,
      toPubkey: providerKp.publicKey,
      lamports: amount,
    }),
    createAssociatedTokenAccountIdempotentInstruction(
      providerKp.publicKey,
      providerWsolAta,
      providerKp.publicKey,
      NATIVE_MINT
    ),
    SystemProgram.transfer({
      fromPubkey: providerKp.publicKey,
      toPubkey: providerWsolAta,
      lamports: amount,
    }),
    createSyncNativeInstruction(providerWsolAta),
  ];

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const tx = new Transaction({
    feePayer: providerKp.publicKey,
    blockhash,
    lastValidBlockHeight,
  });
  for (const ix of ixs) tx.add(ix);
  tx.sign(providerKp, jobKp);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const res = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (res.value.err) {
    throw new Error(
      `returnNativeSolToProviderWsol tx failed: ${JSON.stringify(res.value.err)}`
    );
  }
  return sig;
}

/**
 * Sweep any residual state off the per-job keypair back to the provider
 * main wallet. Closes the passed ATAs (input / output) and transfers
 * leftover native lamports (gas float remainder) to the provider.
 * Idempotent — missing ATAs are silently skipped.
 */
export async function cleanupJobKeypair(
  client: AcpClient,
  jobAddress: string | PublicKey,
  ataMints: PublicKey[]
): Promise<string | null> {
  const connection = connectionOf(client);
  const providerKp = client.keypair;
  const jobAddressStr =
    typeof jobAddress === "string" ? jobAddress : jobAddress.toBase58();
  const jobKp = deriveJobKeypair(providerKp, jobAddressStr);

  const ixs: TransactionInstruction[] = [];

  for (const mint of ataMints) {
    const tokenProgram = await getTokenProgramForMint(connection, mint);
    const ata = getAssociatedTokenAddressSync(
      mint,
      jobKp.publicKey,
      false,
      tokenProgram
    );
    try {
      // `getAccount` validates the account is owned by `tokenProgram`,
      // so passing the wrong program here would mask Token-2022 ATAs.
      await getAccount(connection, ata, "confirmed", tokenProgram);
      // Account must be empty before close; sweep any residual balance
      // to the provider's ATA first so a non-zero output ATA (left over
      // from a swap whose post-transfer didn't run) doesn't strand the
      // job keypair forever.
      const bal = await connection.getTokenAccountBalance(ata, "confirmed");
      const amount = BigInt(bal.value.amount);
      if (amount > 0n) {
        const providerAta = getAssociatedTokenAddressSync(
          mint,
          providerKp.publicKey,
          false,
          tokenProgram
        );
        ixs.push(
          createAssociatedTokenAccountIdempotentInstruction(
            jobKp.publicKey,
            providerAta,
            providerKp.publicKey,
            mint,
            tokenProgram
          ),
          createTransferInstruction(
            ata,
            providerAta,
            jobKp.publicKey,
            amount,
            undefined,
            tokenProgram
          )
        );
      }
      ixs.push(
        createCloseAccountInstruction(
          ata,
          providerKp.publicKey,
          jobKp.publicKey,
          undefined,
          tokenProgram
        )
      );
    } catch {
      /* ATA doesn't exist — nothing to close */
    }
  }

  const residual = await connection.getBalance(jobKp.publicKey, "confirmed");
  const sweepFloor = 10_000;
  if (residual > sweepFloor) {
    ixs.push(
      SystemProgram.transfer({
        fromPubkey: jobKp.publicKey,
        toPubkey: providerKp.publicKey,
        lamports: residual - sweepFloor,
      })
    );
  }

  if (ixs.length === 0) return null;

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const tx = new Transaction({
    feePayer: jobKp.publicKey,
    blockhash,
    lastValidBlockHeight,
  });
  for (const ix of ixs) tx.add(ix);
  tx.sign(jobKp);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const res = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (res.value.err) {
    return sig;
  }
  return sig;
}
