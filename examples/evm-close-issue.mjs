import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { TALK_TO_ME_ESCROW_ABI } from "../src/evm_escrow_abi.js";

const rpcUrl = process.env.EVM_RPC_URL;
const escrow = process.env.EVM_ESCROW_ADDRESS;
const privateKey = process.env.EVM_PRIVATE_KEY;
const issueId = process.env.TALKTOME_ISSUE_ID;
const solver = process.env.TALKTOME_SOLVER_ADDRESS;
if (!rpcUrl || !escrow || !privateKey) throw new Error("Set EVM_RPC_URL, EVM_ESCROW_ADDRESS, EVM_PRIVATE_KEY");
if (!issueId) throw new Error("Set TALKTOME_ISSUE_ID (uint)");
if (!solver) throw new Error("Set TALKTOME_SOLVER_ADDRESS (0x...)");

const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(privateKey, provider);
const c = new Contract(escrow, TALK_TO_ME_ESCROW_ABI, wallet);

const tx = await c.closeIssue(issueId, solver);
const receipt = await tx.wait();
console.log(JSON.stringify({ txHash: receipt.hash }, null, 2));

