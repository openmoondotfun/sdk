import { Connection, PublicKey } from "@solana/web3.js";

export const KNOWN_MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  WSOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

export const NATIVE_MINT = KNOWN_MINTS.SOL;

export function resolveTokenMint(symbolOrAddress: string): string {
  if (!symbolOrAddress) return symbolOrAddress;
  const upper = symbolOrAddress.toUpperCase();
  if (KNOWN_MINTS[upper]) return KNOWN_MINTS[upper];
  return symbolOrAddress;
}

const decimalsCache = new Map<string, number>();

export async function getTokenDecimals(
  conn: Connection,
  mintAddress: string
): Promise<number> {
  if (mintAddress === NATIVE_MINT) return 9;
  const cached = decimalsCache.get(mintAddress);
  if (cached != null) return cached;

  const info = await conn.getParsedAccountInfo(new PublicKey(mintAddress));
  const parsed = (info.value?.data as any)?.parsed?.info;
  const decimals = parsed?.decimals;
  // Only cache a value we actually read from the mint. Never fall back to a
  // guessed 9 — that used to poison the cache permanently on a single
  // transient RPC miss and misscale every 6-decimal (USDC/USDT) amount by
  // 1000x for the whole process. Fail loudly so callers retry instead.
  if (typeof decimals !== "number") {
    throw new Error(
      `Could not resolve decimals for mint ${mintAddress} (account missing or not an SPL mint)`
    );
  }
  decimalsCache.set(mintAddress, decimals);
  return decimals;
}
