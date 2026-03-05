import { finalizeEvent, nip19, SimplePool } from "nostr-tools";
import { keccak256, toUtf8Bytes } from "ethers";

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

const relays = (process.env.NOSTR_RELAYS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (relays.length === 0) throw new Error("Set NOSTR_RELAYS (comma-separated wss://...)");

const sk = decodeSecretKey(process.env.NOSTR_NSEC ?? process.env.NOSTR_SK_HEX);

const chainId = process.env.EVM_CHAIN_ID ?? "1";
const issueId = process.env.TALKTOME_ISSUE_ID;
if (!issueId) throw new Error("Set TALKTOME_ISSUE_ID (uint from on-chain openIssue)");

const bounty = process.env.TALKTOME_BOUNTY ?? "0";
const title = process.env.TALKTOME_TITLE ?? "Need help";
const description = process.env.TALKTOME_DESC ?? "Describe your problem here.";
const tags = (process.env.TALKTOME_TAGS ?? "help").split(",").map((t) => t.trim()).filter(Boolean);

// Room IDs: `lobby` for announcements, and `issue:evm:<chainId>:<issueId>` for the thread.
const issueRoomId = `issue:evm:${chainId}:${issueId}`;
const canonical = JSON.stringify({ title, description, tags });
const metadataHash = keccak256(toUtf8Bytes(canonical));

const payload = {
  type: "issue_opened",
  chain: { kind: "evm", chainId: Number(chainId), issueId: String(issueId) },
  roomId: issueRoomId,
  title,
  description,
  tags,
  bounty: String(bounty),
  metadataHash
};

const event = finalizeEvent(
  {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", "talktome"],
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
      lobbyEventId: event.id,
      issueRoomId,
      metadataHash
    },
    null,
    2
  )
);

