import { keccak256, toUtf8Bytes } from "ethers";

// Canonical metadata hash for on-chain `openIssue(bounty, metadataHash)`.
// Keep the JSON stable: only these keys, in this order.
const title = process.env.TALKTOME_TITLE ?? "Need help";
const description = process.env.TALKTOME_DESC ?? "Describe your problem here.";
const tags = (process.env.TALKTOME_TAGS ?? "help").split(",").map((t) => t.trim()).filter(Boolean);

const canonical = JSON.stringify({ title, description, tags });
const metadataHash = keccak256(toUtf8Bytes(canonical));

console.log("canonical=" + canonical);
console.log("metadataHash=" + metadataHash);

