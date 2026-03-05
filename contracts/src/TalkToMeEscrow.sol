// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
  function transfer(address to, uint256 amount) external returns (bool);
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ITalkToMeToken is IERC20 {
  function mint(address to, uint256 amount) external returns (bool);
  function baseReward() external view returns (uint256);
}

/// @notice Escrow for the talktome decentralized agent marketplace.
///
/// Supports three job types:
///   TOKEN_ONLY   — no deposit; winner receives minted TTM based on complexity
///   STABLE_ONLY  — poster deposits stablecoins; winner receives payout, no TTM mint
///   HYBRID       — poster deposits stablecoins + winner receives stablecoins AND minted TTM
///
/// Evaluator rewards: evaluators who voted for the winner share 10% of the solver's TTM mint.
contract TalkToMeEscrow {
  enum JobType { TOKEN_ONLY, STABLE_ONLY, HYBRID }

  struct Job {
    address opener;
    JobType jobType;
    uint8 complexity;        // 1–10
    address stableToken;     // ERC-20 used for stablecoin bounty (address(0) for token-only)
    uint256 stableBounty;    // stablecoin amount escrowed
    bytes32 metadataHash;
    uint256 deadline;        // unix timestamp; 0 = no deadline
    bool closed;
    bool canceled;
  }

  ITalkToMeToken public immutable ttm;
  address public treasury;
  uint256 public openFee;
  address public owner;

  /// @notice Evaluator reward as basis points of the solver's TTM mint (1000 = 10%).
  uint256 public evalRewardBps = 1000;

  uint256 public nextJobId = 1;
  mapping(uint256 => Job) public jobs;

  event JobOpened(uint256 indexed jobId, address indexed opener, JobType jobType, uint8 complexity, address stableToken, uint256 stableBounty, bytes32 metadataHash, uint256 deadline);
  event JobClosed(uint256 indexed jobId, address indexed opener, address indexed winner, uint256 stablePayout, uint256 ttmMinted);
  event JobCanceled(uint256 indexed jobId, address indexed opener);
  event EvalRewardMinted(uint256 indexed jobId, address indexed evaluator, uint256 amount);
  event ConfigUpdated(address treasury, uint256 openFee);
  event EvalRewardBpsUpdated(uint256 evalRewardBps);
  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

  constructor(address ttm_, address treasury_, uint256 openFee_) {
    require(ttm_ != address(0), "ttm=0");
    require(treasury_ != address(0), "treasury=0");
    ttm = ITalkToMeToken(ttm_);
    treasury = treasury_;
    openFee = openFee_;
    owner = msg.sender;
    emit OwnershipTransferred(address(0), msg.sender);
  }

  modifier onlyOwner() {
    require(msg.sender == owner, "only_owner");
    _;
  }

  function transferOwnership(address newOwner) external onlyOwner {
    require(newOwner != address(0), "owner=0");
    emit OwnershipTransferred(owner, newOwner);
    owner = newOwner;
  }

  function setConfig(address treasury_, uint256 openFee_) external onlyOwner {
    require(treasury_ != address(0), "treasury=0");
    treasury = treasury_;
    openFee = openFee_;
    emit ConfigUpdated(treasury_, openFee_);
  }

  function setEvalRewardBps(uint256 bps) external onlyOwner {
    require(bps <= 5000, "max_50pct");
    evalRewardBps = bps;
    emit EvalRewardBpsUpdated(bps);
  }

  /// @notice Open a job. For TOKEN_ONLY jobs, no deposit is needed — anyone can post for free.
  /// @param complexity 1–10 for TOKEN_ONLY/HYBRID (controls TTM mint); 0 for STABLE_ONLY (no mint).
  function openJob(
    uint8 complexity,
    bytes32 metadataHash,
    address stableToken,
    uint256 stableBounty,
    uint256 deadline
  ) external returns (uint256 jobId) {
    require(complexity <= 10, "complexity_max");

    JobType jt;
    if (stableToken == address(0) || stableBounty == 0) {
      require(complexity >= 1, "complexity_required_for_token_jobs");
      jt = JobType.TOKEN_ONLY;
      stableToken = address(0);
      stableBounty = 0;
    } else if (complexity == 0) {
      jt = JobType.STABLE_ONLY;
    } else {
      jt = JobType.HYBRID;
    }

    jobId = nextJobId++;
    jobs[jobId] = Job({
      opener: msg.sender,
      jobType: jt,
      complexity: complexity,
      stableToken: stableToken,
      stableBounty: stableBounty,
      metadataHash: metadataHash,
      deadline: deadline,
      closed: false,
      canceled: false
    });

    if (openFee > 0) {
      require(ttm.transferFrom(msg.sender, treasury, openFee), "fee_transfer");
    }
    if (stableBounty > 0) {
      require(IERC20(stableToken).transferFrom(msg.sender, address(this), stableBounty), "bounty_transfer");
    }

    emit JobOpened(jobId, msg.sender, jt, complexity, stableToken, stableBounty, metadataHash, deadline);
  }

  /// @notice Close a job: pay the winner (stablecoins + TTM mint) and reward evaluators.
  /// @param jobId The job to close.
  /// @param winner The winning solver's address. Must not be the opener (no self-dealing).
  /// @param evaluators Unique addresses of evaluators who voted for the winner.
  function closeJob(uint256 jobId, address winner, address[] calldata evaluators) external {
    Job storage job = jobs[jobId];
    require(job.opener != address(0), "not_found");
    require(!job.closed && !job.canceled, "finalized");
    require(msg.sender == job.opener, "only_opener");
    require(winner != address(0), "winner=0");
    require(winner != job.opener, "no_self_dealing");

    job.closed = true;

    // Stablecoin payout — guarded against self-dealing above.
    if (job.stableBounty > 0) {
      require(IERC20(job.stableToken).transfer(winner, job.stableBounty), "payout_transfer");
    }

    // TTM mint (TOKEN_ONLY and HYBRID jobs only).
    uint256 solverMint = 0;
    if (job.jobType != JobType.STABLE_ONLY) {
      uint256 base = ttm.baseReward();
      solverMint = base * uint256(job.complexity);

      if (solverMint > 0) {
        require(ttm.mint(winner, solverMint), "solver_mint");

        // Evaluator rewards: deduplicate addresses before minting to prevent inflation.
        if (evaluators.length > 0) {
          uint256 totalEvalReward = (solverMint * evalRewardBps) / 10000;
          uint256 uniqueCount = _countUniqueEligibleEvaluators(evaluators, winner, job.opener);
          if (uniqueCount > 0 && totalEvalReward >= uniqueCount) {
            uint256 perEval = totalEvalReward / uniqueCount;
            // Track which addresses have already been paid to prevent duplicates.
            mapping(address => bool) storage paid = _evalPaid[jobId];
            for (uint256 i = 0; i < evaluators.length; i++) {
              address ev = evaluators[i];
              if (ev == address(0) || ev == winner || ev == job.opener) continue;
              if (paid[ev]) continue;
              paid[ev] = true;
              require(ttm.mint(ev, perEval), "eval_mint");
              emit EvalRewardMinted(jobId, ev, perEval);
            }
          }
        }
      }
    }

    emit JobClosed(jobId, job.opener, winner, job.stableBounty, solverMint);
  }

  // Transient storage for evaluator deduplication per job close.
  mapping(uint256 => mapping(address => bool)) private _evalPaid;

  /// @notice Cancel a job and return escrowed stablecoins. Only callable by opener after deadline.
  function cancelJob(uint256 jobId) external {
    Job storage job = jobs[jobId];
    require(job.opener != address(0), "not_found");
    require(!job.closed && !job.canceled, "finalized");
    require(msg.sender == job.opener, "only_opener");
    require(job.deadline > 0 && block.timestamp > job.deadline, "before_deadline");

    job.canceled = true;

    if (job.stableBounty > 0) {
      require(IERC20(job.stableToken).transfer(job.opener, job.stableBounty), "refund_transfer");
    }

    emit JobCanceled(jobId, job.opener);
  }

  /// @dev Count unique evaluator addresses eligible for rewards (not winner, not opener, no zero address).
  function _countUniqueEligibleEvaluators(
    address[] calldata evaluators,
    address winner,
    address opener
  ) private pure returns (uint256 count) {
    for (uint256 i = 0; i < evaluators.length; i++) {
      address ev = evaluators[i];
      if (ev == address(0) || ev == winner || ev == opener) continue;
      bool seen = false;
      for (uint256 j = 0; j < i; j++) {
        if (evaluators[j] == ev) { seen = true; break; }
      }
      if (!seen) count++;
    }
  }
}
