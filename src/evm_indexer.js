import { Contract, Interface, JsonRpcProvider } from "ethers";
import { TALK_TO_ME_ESCROW_ABI } from "./evm_escrow_abi.js";

function toHex32(bytes32ish) {
  return String(bytes32ish);
}

function issueKey({ chainId, issueId }) {
  return `evm:${chainId}:${issueId}`;
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
    const [token, treasury, openFee] = await Promise.all([
      this.contract.token(),
      this.contract.treasury(),
      this.contract.openFee()
    ]);
    return { chainId: this.chainId, escrow: this.escrowAddress, token, treasury, openFee: openFee.toString() };
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

    const openedTopic = this.iface.getEvent("IssueOpened").topicHash;
    const closedTopic = this.iface.getEvent("IssueClosed").topicHash;

    const logs = await this.provider.getLogs({
      address: this.escrowAddress,
      fromBlock,
      toBlock,
      topics: [[openedTopic, closedTopic]]
    });

    for (const log of logs) {
      const parsed = this.iface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;

      if (parsed.name === "IssueOpened") {
        const issueId = parsed.args.issueId.toString();
        const opener = String(parsed.args.opener).toLowerCase();
        const bounty = parsed.args.bounty.toString();
        const metadataHash = toHex32(parsed.args.metadataHash);
        const key = issueKey({ chainId: this.chainId, issueId });

        const issue = {
          key,
          chainId: this.chainId,
          issueId,
          opener,
          bounty,
          metadataHash,
          openedTx: log.transactionHash,
          openedBlock: log.blockNumber,
          closed: false,
          solver: null,
          closedTx: null,
          closedBlock: null
        };

        this.index.issues[key] = { ...(this.index.issues[key] ?? {}), ...issue };
        await this.chainStore.save(this.index);
        this.onIssueUpsert?.(issue);
      }

      if (parsed.name === "IssueClosed") {
        const issueId = parsed.args.issueId.toString();
        const opener = String(parsed.args.opener).toLowerCase();
        const solver = String(parsed.args.solver).toLowerCase();
        const key = issueKey({ chainId: this.chainId, issueId });

        const existing = this.index.issues[key] ?? { key, chainId: this.chainId, issueId, opener };
        const updated = {
          ...existing,
          opener,
          closed: true,
          solver,
          closedTx: log.transactionHash,
          closedBlock: log.blockNumber
        };

        this.index.issues[key] = updated;
        await this.chainStore.save(this.index);
        this.onIssueUpsert?.(updated);
      }
    }

    this.index.lastProcessedBlock = toBlock;
    await this.chainStore.save(this.index);
  }
}
