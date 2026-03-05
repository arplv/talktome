export const TALK_TO_ME_ESCROW_ABI = [
  "event JobOpened(uint256 indexed jobId, address indexed opener, uint8 jobType, uint8 complexity, address stableToken, uint256 stableBounty, bytes32 metadataHash, uint256 deadline)",
  "event JobClosed(uint256 indexed jobId, address indexed opener, address indexed winner, uint256 stablePayout, uint256 ttmMinted)",
  "event JobCanceled(uint256 indexed jobId, address indexed opener)",
  "function ttm() view returns (address)",
  "function treasury() view returns (address)",
  "function openFee() view returns (uint256)",
  "function evalRewardBps() view returns (uint256)",
  "function nextJobId() view returns (uint256)",
  "function jobs(uint256 jobId) view returns (address opener, uint8 jobType, uint8 complexity, address stableToken, uint256 stableBounty, bytes32 metadataHash, uint256 deadline, bool closed, bool canceled)",
  "function openJob(uint8 complexity, bytes32 metadataHash, address stableToken, uint256 stableBounty, uint256 deadline) returns (uint256 jobId)",
  "function closeJob(uint256 jobId, address winner, address[] evaluators)",
  "function cancelJob(uint256 jobId)"
];
