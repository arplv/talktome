import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";
import WebSocket from "ws";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { finalizeEvent } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { TALK_TO_ME_ESCROW_ABI } from "../src/evm_escrow_abi.js";

useWebSocketImplementation(WebSocket);

function decodeSecretKey(value) {
  const v = String(value || "").trim();
  if (!v) throw new Error("Set NOSTR_NSEC or NOSTR_SK_HEX");
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
const sk = decodeSecretKey(process.env.NOSTR_NSEC ?? process.env.NOSTR_SK_HEX);

const bounty = BigInt(process.env.TALKTOME_BOUNTY ?? "0");
const title = process.env.TALKTOME_TITLE ?? "Need help";
const description = process.env.TALKTOME_DESC ?? "Describe your problem here.";
const tags = (process.env.TALKTOME_TAGS ?? "help").split(",").map((t) => t.trim()).filter(Boolean);

const canonical = JSON.stringify({ title, description, tags });
const metadataHash = keccak256(toUtf8Bytes(canonical));

const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(privateKey, provider);
const c = new Contract(escrow, TALK_TO_ME_ESCROW_ABI, wallet);

const tokenAddress = await c.token();
const openFee = await c.openFee();
const total = openFee + bounty;

const erc20 = new Contract(
  tokenAddress,
  ["function allowance(address owner,address spender) view returns (uint256)", "function approve(address spender,uint256 amount) returns (bool)"],
  wallet
);
const allowance = await erc20.allowance(wallet.address, escrow);
if (allowance < total) {
  const approveTx = await erc20.approve(escrow, total);
  await approveTx.wait();
}

const tx = await c.openIssue(bounty, metadataHash);
const receipt = await tx.wait();
const opened = receipt.logs
  .map((l) => {
    try {
      return c.interface.parseLog(l);
    } catch {
      return null;
    }
  })
  .find((p) => p && p.name === "IssueOpened");

const issueId = opened?.args?.issueId?.toString?.();
if (!issueId) throw new Error("Could not parse IssueOpened(issueId) from receipt");

const issueRoomId = `issue:evm:${chainId}:${issueId}`;
const payload = {
  type: "issue_opened",
  chain: { kind: "evm", chainId: Number(chainId), issueId: String(issueId), escrow },
  roomId: issueRoomId,
  title,
  description,
  tags,
  bounty: bounty.toString(),
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
      ["d2", issueRoomId],
      ["x", "issue_opened"],
      ["m", metadataHash]
    ],
    content: JSON.stringify(payload)
  },
  sk
);

const pool = new SimplePool();
await Promise.allSettled(pool.publish(relays, event));
pool.destroy();

console.log(
  JSON.stringify(
    {
      ok: true,
      chainTx: receipt.hash,
      issueId,
      issueRoomId,
      metadataHash,
      nostrEventId: event.id
    },
    null,
    2
  )
);
