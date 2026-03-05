pragma solidity ^0.8.20;

interface IERC20 {
  function transfer(address to, uint256 amount) external returns (bool);
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IMintableERC20 is IERC20 {
  function mint(address to, uint256 amount) external returns (bool);
}

/// @notice Minimal ERC-20 bounty escrow for talktome issues.
/// - Payments are on-chain.
/// - Conversation/metadata can live off-chain (this repo provides an HTTP/WS hub + storage).
contract TalkToMeEscrow {
  struct Issue {
    address opener;
    uint256 bounty;
    bytes32 metadataHash;
    bool closed;
  }

  IMintableERC20 public immutable token;
  address public treasury;
  uint256 public openFee;
  uint256 public solveReward;
  address public owner;

  uint256 public nextIssueId = 1;
  mapping(uint256 => Issue) public issues;

  event IssueOpened(uint256 indexed issueId, address indexed opener, uint256 bounty, bytes32 metadataHash);
  event IssueClosed(uint256 indexed issueId, address indexed opener, address indexed solver, uint256 bounty);
  event ConfigUpdated(address treasury, uint256 openFee);
  event SolveRewardUpdated(uint256 solveReward);
  event SolveRewardMinted(uint256 indexed issueId, address indexed solver, uint256 amount);
  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

  constructor(address token_, address treasury_, uint256 openFee_, uint256 solveReward_) {
    require(token_ != address(0), "token=0");
    require(treasury_ != address(0), "treasury=0");
    token = IMintableERC20(token_);
    treasury = treasury_;
    openFee = openFee_;
    solveReward = solveReward_;
    owner = msg.sender;
    emit OwnershipTransferred(address(0), msg.sender);
  }

  function setConfig(address treasury_, uint256 openFee_) external {
    require(msg.sender == owner, "only_owner");
    treasury = treasury_;
    openFee = openFee_;
    emit ConfigUpdated(treasury_, openFee_);
  }

  function setSolveReward(uint256 solveReward_) external {
    require(msg.sender == owner, "only_owner");
    solveReward = solveReward_;
    emit SolveRewardUpdated(solveReward_);
  }

  function transferOwnership(address newOwner) external {
    require(msg.sender == owner, "only_owner");
    require(newOwner != address(0), "owner=0");
    emit OwnershipTransferred(owner, newOwner);
    owner = newOwner;
  }

  function openIssue(uint256 bounty, bytes32 metadataHash) external returns (uint256 issueId) {
    issueId = nextIssueId++;
    issues[issueId] = Issue({ opener: msg.sender, bounty: bounty, metadataHash: metadataHash, closed: false });

    if (openFee > 0) {
      require(token.transferFrom(msg.sender, treasury, openFee), "fee_transfer");
    }
    if (bounty > 0) {
      require(token.transferFrom(msg.sender, address(this), bounty), "bounty_transfer");
    }

    emit IssueOpened(issueId, msg.sender, bounty, metadataHash);
  }

  function closeIssue(uint256 issueId, address solver) external {
    Issue storage issue = issues[issueId];
    require(issue.opener != address(0), "not_found");
    require(!issue.closed, "closed");
    require(msg.sender == issue.opener, "only_opener");
    require(solver != address(0), "solver=0");

    issue.closed = true;
    if (issue.bounty > 0) {
      require(token.transfer(solver, issue.bounty), "payout_transfer");
    }

    // "Solve-to-earn": mint additional reward tokens to the solver.
    // Requires `token` to be mintable and this escrow to be set as `minter`.
    if (solveReward > 0) {
      require(token.mint(solver, solveReward), "mint_failed");
      emit SolveRewardMinted(issueId, solver, solveReward);
    }

    emit IssueClosed(issueId, issue.opener, solver, issue.bounty);
  }
}
