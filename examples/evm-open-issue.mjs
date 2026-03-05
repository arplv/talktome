import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { TALK_TO_ME_ESCROW_ABI } from "../src/evm_escrow_abi.js";

const rpcUrl = process.env.EVM_RPC_URL;
const escrow = process.env.EVM_ESCROW_ADDRESS;
const privateKey = process.env.EVM_PRIVATE_KEY;
if (!rpcUrl || !escrow || !privateKey) {
  throw new Error("Set EVM_RPC_URL, EVM_ESCROW_ADDRESS, EVM_PRIVATE_KEY");
}

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

// Minimal ERC-20 approve/allowance.
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
const opened = receipt.logs.map((l) => {
  try {
    return c.interface.parseLog(l);
  } catch {
    return null;
  }
}).find((p) => p && p.name === "IssueOpened");

console.log(
  JSON.stringify(
    {
      canonical,
      metadataHash,
      txHash: receipt.hash,
      issueId: opened?.args?.issueId?.toString?.() ?? null
    },
    null,
    2
  )
);

