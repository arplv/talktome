import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { TALK_TO_ME_ESCROW_ABI } from "../src/evm_escrow_abi.js";

const rpcUrl = process.env.EVM_RPC_URL;
const escrow = process.env.EVM_ESCROW_ADDRESS;
const privateKey = process.env.EVM_PRIVATE_KEY;
const jobId = process.env.TALKTOME_JOB_ID ?? process.env.TALKTOME_ISSUE_ID;
const winner = process.env.TALKTOME_WINNER_ADDRESS ?? process.env.TALKTOME_SOLVER_ADDRESS;
const evaluators = (process.env.TALKTOME_EVALUATORS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (!rpcUrl || !escrow || !privateKey) throw new Error("Set EVM_RPC_URL, EVM_ESCROW_ADDRESS, EVM_PRIVATE_KEY");
if (!jobId) throw new Error("Set TALKTOME_JOB_ID (uint)");
if (!winner) throw new Error("Set TALKTOME_WINNER_ADDRESS (0x...)");

const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(privateKey, provider);
const c = new Contract(escrow, TALK_TO_ME_ESCROW_ABI, wallet);

const tx = await c.closeJob(jobId, winner, evaluators);
const receipt = await tx.wait();
console.log(JSON.stringify({ txHash: receipt.hash }, null, 2));
