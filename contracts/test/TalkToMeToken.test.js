const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TalkToMeToken", function () {
  const CAP = ethers.utils.parseEther("1000000");
  const BASE_REWARD = ethers.utils.parseEther("10");

  async function deploy() {
    const [owner, minter, alice, bob] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("TalkToMeToken");
    const token = await Token.deploy("TalkToMe", "TTM", CAP, BASE_REWARD);
    await token.deployed();
    return { token, owner, minter, alice, bob };
  }

  it("sets name, symbol, cap, baseReward on deploy", async function () {
    const { token } = await deploy();
    expect(await token.name()).to.equal("TalkToMe");
    expect(await token.symbol()).to.equal("TTM");
    expect(await token.cap()).to.equal(CAP);
    expect(await token.baseReward()).to.equal(BASE_REWARD);
  });

  it("owner can setMinter", async function () {
    const { token, owner, minter } = await deploy();
    await token.connect(owner).setMinter(minter.address);
    expect(await token.minter()).to.equal(minter.address);
  });

  it("setMinter reverts on address(0)", async function () {
    const { token, owner } = await deploy();
    await expect(token.connect(owner).setMinter(ethers.constants.AddressZero))
      .to.be.revertedWith("minter=0");
  });

  it("minter can mint up to cap", async function () {
    const { token, owner, minter, alice } = await deploy();
    await token.connect(owner).setMinter(minter.address);
    await token.connect(minter).mint(alice.address, ethers.utils.parseEther("100"));
    expect(await token.balanceOf(alice.address)).to.equal(ethers.utils.parseEther("100"));
  });

  it("mint reverts past cap", async function () {
    const { token, owner, minter, alice } = await deploy();
    await token.connect(owner).setMinter(minter.address);
    await expect(token.connect(minter).mint(alice.address, CAP.add(1)))
      .to.be.revertedWith("cap");
  });

  it("non-minter cannot mint", async function () {
    const { token, alice, bob } = await deploy();
    await expect(token.connect(alice).mint(bob.address, 1))
      .to.be.revertedWith("only_minter");
  });

  it("transfer works between accounts", async function () {
    const { token, owner, minter, alice, bob } = await deploy();
    await token.connect(owner).setMinter(minter.address);
    await token.connect(minter).mint(alice.address, ethers.utils.parseEther("50"));
    await token.connect(alice).transfer(bob.address, ethers.utils.parseEther("20"));
    expect(await token.balanceOf(bob.address)).to.equal(ethers.utils.parseEther("20"));
    expect(await token.balanceOf(alice.address)).to.equal(ethers.utils.parseEther("30"));
  });

  it("owner can update baseReward", async function () {
    const { token, owner } = await deploy();
    await token.connect(owner).setBaseReward(ethers.utils.parseEther("5"));
    expect(await token.baseReward()).to.equal(ethers.utils.parseEther("5"));
  });
});
