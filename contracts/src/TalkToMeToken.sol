// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal ERC-20 with a hard cap and escrow-only minting.
/// Tokens are minted only when a solver wins a job (solve-to-mint).
/// For production, prefer OpenZeppelin ERC20 + AccessControl.
contract TalkToMeToken {
  string public name;
  string public symbol;
  uint8 public constant decimals = 18;

  uint256 public totalSupply;
  uint256 public immutable cap;

  address public owner;
  address public minter;

  /// @notice Base reward per unit of complexity. mintAmount = baseReward * complexityScore
  uint256 public baseReward;

  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  event Transfer(address indexed from, address indexed to, uint256 value);
  event Approval(address indexed owner, address indexed spender, uint256 value);
  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
  event MinterUpdated(address indexed minter);
  event BaseRewardUpdated(uint256 baseReward);

  constructor(string memory name_, string memory symbol_, uint256 cap_, uint256 baseReward_) {
    require(cap_ > 0, "cap=0");
    name = name_;
    symbol = symbol_;
    cap = cap_;
    baseReward = baseReward_;
    owner = msg.sender;
    emit OwnershipTransferred(address(0), msg.sender);
  }

  modifier onlyOwner() {
    require(msg.sender == owner, "only_owner");
    _;
  }

  modifier onlyMinter() {
    require(msg.sender == minter, "only_minter");
    _;
  }

  function transferOwnership(address newOwner) external onlyOwner {
    require(newOwner != address(0), "owner=0");
    emit OwnershipTransferred(owner, newOwner);
    owner = newOwner;
  }

  function setMinter(address minter_) external onlyOwner {
    require(minter_ != address(0), "minter=0");
    minter = minter_;
    emit MinterUpdated(minter_);
  }

  function setBaseReward(uint256 baseReward_) external onlyOwner {
    baseReward = baseReward_;
    emit BaseRewardUpdated(baseReward_);
  }

  function approve(address spender, uint256 value) external returns (bool) {
    allowance[msg.sender][spender] = value;
    emit Approval(msg.sender, spender, value);
    return true;
  }

  function transfer(address to, uint256 value) external returns (bool) {
    _transfer(msg.sender, to, value);
    return true;
  }

  function transferFrom(address from, address to, uint256 value) external returns (bool) {
    uint256 allowed = allowance[from][msg.sender];
    require(allowed >= value, "allowance");
    if (allowed != type(uint256).max) {
      allowance[from][msg.sender] = allowed - value;
      emit Approval(from, msg.sender, allowance[from][msg.sender]);
    }
    _transfer(from, to, value);
    return true;
  }

  function mint(address to, uint256 value) external onlyMinter returns (bool) {
    _mint(to, value);
    return true;
  }

  function _mint(address to, uint256 value) internal {
    require(to != address(0), "to=0");
    require(totalSupply + value <= cap, "cap");
    totalSupply += value;
    balanceOf[to] += value;
    emit Transfer(address(0), to, value);
  }

  function _transfer(address from, address to, uint256 value) internal {
    require(to != address(0), "to=0");
    uint256 bal = balanceOf[from];
    require(bal >= value, "balance");
    balanceOf[from] = bal - value;
    balanceOf[to] += value;
    emit Transfer(from, to, value);
  }
}
