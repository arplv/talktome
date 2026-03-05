export const TALK_TO_ME_ESCROW_ABI = [
  "event IssueOpened(uint256 indexed issueId, address indexed opener, uint256 bounty, bytes32 metadataHash)",
  "event IssueClosed(uint256 indexed issueId, address indexed opener, address indexed solver, uint256 bounty)",
  "function token() view returns (address)",
  "function treasury() view returns (address)",
  "function openFee() view returns (uint256)",
  "function solveReward() view returns (uint256)",
  "function issues(uint256 issueId) view returns (address opener, uint256 bounty, bytes32 metadataHash, bool closed)"
];
