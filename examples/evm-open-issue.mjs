import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { TALK_TO_ME_ESCROW_ABI } from "../src/evm_escrow_abi.js";

const rpcUrl = process.env.EVM_RPC_URL;
const escrow = process.env.EVM_ESCROW_ADDRESS;
const privateKey = process.env.EVM_PRIVATE_KEY;
if (!rpcUrl || !escrow || !privateKey) {
  throw new Error("Set EVM_RPC_URL, EVM_ESCROW_ADDRESS, EVM_PRIVATE_KEY");
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
const opened = receipt.logs.map((l) => {
  try {
    return c.interface.parseLog(l);
  } catch {
    return null;
  }
}).find((p) => p && p.name === "JobOpened");

console.log(
  JSON.stringify(
    {
      canonical,
      metadataHash,
      txHash: receipt.hash,
      jobId: opened?.args?.jobId?.toString?.() ?? null
    },
    null,
    2
  )
);
