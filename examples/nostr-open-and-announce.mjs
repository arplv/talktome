import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";
import WebSocket from "ws";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { finalizeEvent } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { TALK_TO_ME_ESCROW_ABI } from "../src/evm_escrow_abi.js";
import { loadOrCreateNostrIdentity, getDefaultNostrIdentityPath } from "../src/nostr_identity.js";

useWebSocketImplementation(WebSocket);

function decodeSecretKey(value) {
  const v = String(value || "").trim();
  if (!v) return null;
  if (v.startsWith("nsec")) {
    const decoded = nip19.decode(v);
    if (decoded.type !== "nsec") throw new Error("Invalid nsec");
    return decoded.data;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error("Invalid secret key hex");
  return Uint8Array.from(Buffer.from(v, "hex"));
}

const rpcUrl = process.env.EVM_RPC_URL;
const escrow = process.env.EVM_ESCROW_ADDRESS;
const privateKey = process.env.EVM_PRIVATE_KEY;
const chainId = process.env.EVM_CHAIN_ID ?? "1";
if (!rpcUrl || !escrow || !privateKey) throw new Error("Set EVM_RPC_URL, EVM_ESCROW_ADDRESS, EVM_PRIVATE_KEY");

const relays = (process.env.NOSTR_RELAYS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (relays.length === 0) throw new Error("Set NOSTR_RELAYS (comma-separated wss://...)");
let sk = null;
try { sk = decodeSecretKey(process.env.NOSTR_NSEC ?? process.env.NOSTR_SK_HEX); } catch { sk = null; }
if (!sk) {
  const identityPath = process.env.TALKTOME_IDENTITY_PATH ?? getDefaultNostrIdentityPath();
  const ident = loadOrCreateNostrIdentity({ identityPath, createIfMissing: true });
  sk = ident.sk;
}

const complexity = Number.parseInt(process.env.TALKTOME_COMPLEXITY ?? "3", 10);
const stableToken = process.env.TALKTOME_STABLE_TOKEN ?? "0x0000000000000000000000000000000000000000";
const stableBounty = BigInt(process.env.TALKTOME_STABLE_BOUNTY ?? "0");
const deadline = BigInt(process.env.TALKTOME_DEADLINE_UNIX ?? "0");
const title = process.env.TALKTOME_TITLE ?? "Need help";
const description = process.env.TALKTOME_DESC ?? "Describe your problem here.";
const tags = (process.env.TALKTOME_TAGS ?? "help").split(",").map((t) => t.trim()).filter(Boolean);

const canonical = JSON.stringify({ title, description, tags });
const metadataHash = keccak256(toUtf8Bytes(canonical));

const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(privateKey, provider);
const c = new Contract(escrow, TALK_TO_ME_ESCROW_ABI, wallet);

const tokenAddress = await c.ttm();
const openFee = await c.openFee();

// Approve TTM open fee (if any).
const ttm = new Contract(
  tokenAddress,
  ["function allowance(address owner,address spender) view returns (uint256)", "function approve(address spender,uint256 amount) returns (bool)"],
  wallet
);
const allowance = await ttm.allowance(wallet.address, escrow);
if (allowance < openFee) {
  const approveTx = await ttm.approve(escrow, openFee);
  await approveTx.wait();
}

// Approve stable bounty (if any).
if (stableToken !== "0x0000000000000000000000000000000000000000" && stableBounty > 0n) {
  const stable = new Contract(
    stableToken,
    ["function allowance(address owner,address spender) view returns (uint256)", "function approve(address spender,uint256 amount) returns (bool)"],
    wallet
  );
  const stableAllowance = await stable.allowance(wallet.address, escrow);
  if (stableAllowance < stableBounty) {
    const approveTx = await stable.approve(escrow, stableBounty);
    await approveTx.wait();
  }
}

const tx = await c.openJob(complexity, metadataHash, stableToken, stableBounty, deadline);
const receipt = await tx.wait();
const opened = receipt.logs
  .map((l) => {
    try {
      return c.interface.parseLog(l);
    } catch {
      return null;
    }
  })
  .find((p) => p && p.name === "JobOpened");

const jobId = opened?.args?.jobId?.toString?.();
if (!jobId) throw new Error("Could not parse JobOpened(jobId) from receipt");

const jobRoomId = `job:evm:${chainId}:${jobId}`;
const payload = {
  type: "job_opened",
  chain: { kind: "evm", chainId: Number(chainId), jobId: String(jobId), escrow, txHash: receipt.hash },
  roomId: jobRoomId,
  title,
  description,
  tags,
  complexity,
  stableToken,
  stableBounty: stableBounty.toString(),
  deadline_unix: Number(deadline || 0n),
  metadataHash
};

const event = finalizeEvent(
  {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", "talktome"],
      ["t", "room:lobby"],
      ["d", "lobby"],
      ["d2", jobRoomId],
      ["x", "job_opened"],
      ["m", metadataHash]
    ],
    content: JSON.stringify(payload)
  },
  sk
);

const pool = new SimplePool();
await Promise.allSettled(pool.publish(relays, event));

// Also publish the job context into the job room for easy fetching.
const roomEvent = finalizeEvent(
  {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["t", "talktome"], ["t", `room:${jobRoomId}`], ["d", jobRoomId], ["x", "job_context"], ["m", metadataHash]],
    content: JSON.stringify(payload)
  },
  sk
);
await Promise.allSettled(pool.publish(relays, roomEvent));
pool.destroy();

console.log(
  JSON.stringify(
    {
      ok: true,
      chainTx: receipt.hash,
      jobId,
      jobRoomId,
      metadataHash,
      nostrEventId: event.id,
      roomEventId: roomEvent.id
    },
    null,
    2
  )
);
