import crypto from "node:crypto";

export function hashContent(text: string): number[] {
  return Array.from(crypto.createHash("sha256").update(text).digest());
}

export function hashToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}
