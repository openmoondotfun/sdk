import fs from "node:fs";
import path from "node:path";

let _idl: any | null = null;

/**
 * Load the ACP IDL. Tries the bundled copy first (shipped with acp-core),
 * then falls back to caller-provided paths. Caches the result.
 */
export function loadAcpIdl(extraCandidates: string[] = []): any {
  if (_idl) return _idl;

  const bundled = path.resolve(__dirname, "..", "idl", "virtuals_acp.json");
  const candidates = [bundled, ...extraCandidates];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      _idl = JSON.parse(fs.readFileSync(p, "utf-8"));
      return _idl;
    }
  }
  throw new Error(`ACP IDL not found at any of: ${candidates.join(", ")}`);
}
