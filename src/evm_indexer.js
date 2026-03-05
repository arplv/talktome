import { Contract, Interface, JsonRpcProvider } from "ethers";
import { TALK_TO_ME_ESCROW_ABI } from "./evm_escrow_abi.js";

function toHex32(bytes32ish) {
  return String(bytes32ish);
}

function jobKey({ chainId, jobId }) {
  return `evm:${chainId}:${jobId}`;
}

export class EvmIndexer {
  constructor({ rpcUrl, chainId, escrowAddress, startBlock, pollMs, chainStore, onIssueUpsert }) {
    this.rpcUrl = rpcUrl;
    this.chainId = chainId;
    this.escrowAddress = escrowAddress;
    this.startBlock = startBlock ?? null;
    this.pollMs = pollMs ?? 5000;
    this.chainStore = chainStore;
    this.onIssueUpsert = onIssueUpsert;

    this.provider = new JsonRpcProvider(this.rpcUrl);
    this.iface = new Interface(TALK_TO_ME_ESCROW_ABI);
    this.contract = new Contract(this.escrowAddress, TALK_TO_ME_ESCROW_ABI, this.provider);

    this.timer = null;
    this.running = false;
    this.index = null;
  }

  async getConfig() {
    const [ttm, treasury, openFee, evalRewardBps] = await Promise.all([
      this.contract.ttm(),
      this.contract.treasury(),
      this.contract.openFee(),
      this.contract.evalRewardBps()
    ]);
    return {
      chainId: this.chainId,
      escrow: this.escrowAddress,
      ttm,
      treasury,
      openFee: openFee.toString(),
      evalRewardBps: evalRewardBps.toString()
    };
  }

  async init() {
    await this.chainStore.init();
    this.index = await this.chainStore.load();
    if (this.index.lastProcessedBlock === null) {
      const latest = await this.provider.getBlockNumber();
      this.index.lastProcessedBlock = this.startBlock ?? latest;
      await this.chainStore.save(this.index);
    }
  }

  getIndexSnapshot() {
    return this.index ? JSON.parse(JSON.stringify(this.index)) : null;
  }

  start() {
    if (this.timer) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.pollOnce();
      } catch {
        // ignore poll errors; retry next tick
      } finally {
        this.timer = setTimeout(tick, this.pollMs);
      }
    };
    this.timer = setTimeout(tick, 50);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async pollOnce() {
    if (!this.index) throw new Error("not_initialized");
    const fromBlock = Number(this.index.lastProcessedBlock) + 1;
    const toBlock = await this.provider.getBlockNumber();
    if (fromBlock > toBlock) return;

    const openedTopic = this.iface.getEvent("JobOpened").topicHash;
    const closedTopic = this.iface.getEvent("JobClosed").topicHash;
    const canceledTopic = this.iface.getEvent("JobCanceled").topicHash;

    const logs = await this.provider.getLogs({
      address: this.escrowAddress,
      fromBlock,
      toBlock,
      topics: [[openedTopic, closedTopic, canceledTopic]]
    });

    for (const log of logs) {
      const parsed = this.iface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;

      if (parsed.name === "JobOpened") {
        const jobId = parsed.args.jobId.toString();
        const opener = String(parsed.args.opener).toLowerCase();
        const jobType = Number(parsed.args.jobType);
        const complexity = Number(parsed.args.complexity);
        const stableToken = String(parsed.args.stableToken).toLowerCase();
        const stableBounty = parsed.args.stableBounty.toString();
        const metadataHash = toHex32(parsed.args.metadataHash);
        const deadline = parsed.args.deadline.toString();
        const key = jobKey({ chainId: this.chainId, jobId });

        const job = {
          key,
          chainId: this.chainId,
          jobId,
          opener,
          jobType,
          complexity,
          stableToken,
          stableBounty,
          metadataHash,
          deadline,
          openedTx: log.transactionHash,
          openedBlock: log.blockNumber,
          closed: false,
          canceled: false,
          winner: null,
          stablePayout: null,
          ttmMinted: null,
          closedTx: null,
          closedBlock: null
        };

        this.index.issues[key] = { ...(this.index.issues[key] ?? {}), ...job };
        await this.chainStore.save(this.index);
        this.onIssueUpsert?.(job);
      }

      if (parsed.name === "JobClosed") {
        const jobId = parsed.args.jobId.toString();
        const opener = String(parsed.args.opener).toLowerCase();
        const winner = String(parsed.args.winner).toLowerCase();
        const stablePayout = parsed.args.stablePayout.toString();
        const ttmMinted = parsed.args.ttmMinted.toString();
        const key = jobKey({ chainId: this.chainId, jobId });

        const existing = this.index.issues[key] ?? { key, chainId: this.chainId, jobId, opener };
        const updated = {
          ...existing,
          opener,
          closed: true,
          canceled: false,
          winner,
          stablePayout,
          ttmMinted,
          closedTx: log.transactionHash,
          closedBlock: log.blockNumber
        };

        this.index.issues[key] = updated;
        await this.chainStore.save(this.index);
        this.onIssueUpsert?.(updated);
      }

      if (parsed.name === "JobCanceled") {
        const jobId = parsed.args.jobId.toString();
        const opener = String(parsed.args.opener).toLowerCase();
        const key = jobKey({ chainId: this.chainId, jobId });
        const existing = this.index.issues[key] ?? { key, chainId: this.chainId, jobId, opener };
        const updated = { ...existing, opener, canceled: true, closed: false };
        this.index.issues[key] = updated;
        await this.chainStore.save(this.index);
        this.onIssueUpsert?.(updated);
      }
    }

    this.index.lastProcessedBlock = toBlock;
    await this.chainStore.save(this.index);
  }
}
