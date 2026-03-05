import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nsecEncode, npubEncode } from "nostr-tools/nip19";

function defaultIdentityPath() {
  return path.join(os.homedir(), ".talktome", "nostr-identity.json");
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function writeJson0600(filePath, obj) {
  ensureDirForFile(filePath);
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on non-POSIX FS
  }
}

function skHexToBytes(skHex) {
  if (!/^[0-9a-fA-F]{64}$/.test(skHex)) throw new Error("invalid_sk_hex");
  return Uint8Array.from(Buffer.from(skHex, "hex"));
}

/**
 * Load a persisted Nostr identity, or create one if missing.
 *
 * This is intentionally "batteries included" for local agent usage.
 * For production, prefer a real secret manager / signer.
 */
export function loadOrCreateNostrIdentity({
  identityPath = defaultIdentityPath(),
  createIfMissing = true
} = {}) {
  const p = String(identityPath || "").trim() || defaultIdentityPath();
  if (fs.existsSync(p)) {
    const data = readJson(p);
    if (typeof data?.skHex !== "string") throw new Error("identity_missing_sk");
    const sk = skHexToBytes(data.skHex);
    const pubkey = getPublicKey(sk);
    return { identityPath: p, created: false, sk, pubkey, npub: npubEncode(pubkey), nsec: nsecEncode(sk) };
  }

  if (!createIfMissing) return null;

  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const identity = {
    v: 1,
    createdAt: new Date().toISOString(),
    skHex: Buffer.from(sk).toString("hex"),
    pkHex: pubkey,
    npub: npubEncode(pubkey)
  };
  writeJson0600(p, identity);
  return { identityPath: p, created: true, sk, pubkey, npub: identity.npub, nsec: nsecEncode(sk) };
}

export function getDefaultNostrIdentityPath() {
  return defaultIdentityPath();
}

