const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TalkToMeEscrow", function () {
  const CAP = ethers.utils.parseEther("10000000");
  const BASE_REWARD = ethers.utils.parseEther("10"); // 10 TTM per complexity unit

  async function deploy() {
    const [owner, treasury, alice, bob, carol, dave] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("TalkToMeToken");
    const token = await Token.deploy("TalkToMe", "TTM", CAP, BASE_REWARD);
    await token.deployed();

    const Escrow = await ethers.getContractFactory("TalkToMeEscrow");
    const escrow = await Escrow.deploy(token.address, treasury.address, 0);
    await escrow.deployed();

    await token.connect(owner).setMinter(escrow.address);

    return { token, escrow, owner, treasury, alice, bob, carol, dave };
  }

  // --- openJob ---

  describe("openJob (TOKEN_ONLY)", function () {
    it("creates a token-only job with complexity 1–10", async function () {
      const { escrow, alice } = await deploy();
      await expect(escrow.connect(alice).openJob(5, ethers.constants.HashZero, ethers.constants.AddressZero, 0, 0))
        .to.emit(escrow, "JobOpened");
      const job = await escrow.jobs(1);
      expect(job.opener).to.equal(alice.address);
      expect(job.complexity).to.equal(5);
      expect(job.jobType).to.equal(0); // TOKEN_ONLY
    });

    it("reverts if complexity is 0 for token-only", async function () {
      const { escrow, alice } = await deploy();
      await expect(
        escrow.connect(alice).openJob(0, ethers.constants.HashZero, ethers.constants.AddressZero, 0, 0)
      ).to.be.revertedWith("complexity_required_for_token_jobs");
    });

    it("reverts if complexity > 10", async function () {
      const { escrow, alice } = await deploy();
      await expect(
        escrow.connect(alice).openJob(11, ethers.constants.HashZero, ethers.constants.AddressZero, 0, 0)
      ).to.be.revertedWith("complexity_max");
    });
  });

  // --- closeJob (TOKEN_ONLY) ---

  describe("closeJob (TOKEN_ONLY)", function () {
    it("mints baseReward * complexity TTM to winner", async function () {
      const { escrow, token, alice, bob } = await deploy();
      await escrow.connect(alice).openJob(3, ethers.constants.HashZero, ethers.constants.AddressZero, 0, 0);
      await escrow.connect(alice).closeJob(1, bob.address, []);
      const expected = BASE_REWARD.mul(3);
      expect(await token.balanceOf(bob.address)).to.equal(expected);
    });

    it("reverts on self-dealing (winner == opener)", async function () {
      const { escrow, alice } = await deploy();
      await escrow.connect(alice).openJob(3, ethers.constants.HashZero, ethers.constants.AddressZero, 0, 0);
      await expect(escrow.connect(alice).closeJob(1, alice.address, []))
        .to.be.revertedWith("no_self_dealing");
    });

    it("only opener can close", async function () {
      const { escrow, alice, bob, carol } = await deploy();
      await escrow.connect(alice).openJob(3, ethers.constants.HashZero, ethers.constants.AddressZero, 0, 0);
      await expect(escrow.connect(bob).closeJob(1, carol.address, []))
        .to.be.revertedWith("only_opener");
    });

    it("cannot close twice", async function () {
      const { escrow, alice, bob } = await deploy();
      await escrow.connect(alice).openJob(3, ethers.constants.HashZero, ethers.constants.AddressZero, 0, 0);
      await escrow.connect(alice).closeJob(1, bob.address, []);
      await expect(escrow.connect(alice).closeJob(1, bob.address, []))
        .to.be.revertedWith("finalized");
    });

    it("mints evaluator rewards to unique eligible evaluators", async function () {
      const { escrow, token, alice, bob, carol, dave } = await deploy();
      await escrow.connect(alice).openJob(10, ethers.constants.HashZero, ethers.constants.AddressZero, 0, 0);
      // carol and dave are evaluators; dave is listed twice (should only be paid once)
      await escrow.connect(alice).closeJob(1, bob.address, [carol.address, dave.address, dave.address]);
      const solverMint = BASE_REWARD.mul(10);
      expect(await token.balanceOf(bob.address)).to.equal(solverMint);
      const totalEval = solverMint.mul(1000).div(10000); // 10%
      const perEval = totalEval.div(2); // 2 unique evaluators
      expect(await token.balanceOf(carol.address)).to.equal(perEval);
      expect(await token.balanceOf(dave.address)).to.equal(perEval); // paid once, not twice
    });

    it("excludes winner from evaluator reward when listed as evaluator", async function () {
      const { escrow, token, alice, bob, carol } = await deploy();
      await escrow.connect(alice).openJob(10, ethers.constants.HashZero, ethers.constants.AddressZero, 0, 0);
      // bob is winner AND listed as evaluator — should not double-dip
      await escrow.connect(alice).closeJob(1, bob.address, [bob.address, carol.address]);
      const solverMint = BASE_REWARD.mul(10);
      const totalEval = solverMint.mul(1000).div(10000);
      const perEval = totalEval.div(1); // only carol is eligible
      expect(await token.balanceOf(carol.address)).to.equal(perEval);
    });
  });

  // --- admin guards ---

  describe("admin guards", function () {
    it("setConfig reverts on treasury = address(0)", async function () {
      const { escrow, owner } = await deploy();
      await expect(escrow.connect(owner).setConfig(ethers.constants.AddressZero, 0))
        .to.be.revertedWith("treasury=0");
    });

    it("only owner can setConfig", async function () {
      const { escrow, alice, treasury } = await deploy();
      await expect(escrow.connect(alice).setConfig(treasury.address, 0))
        .to.be.revertedWith("only_owner");
    });
  });

  // --- cancelJob ---

  describe("cancelJob", function () {
    it("reverts before deadline", async function () {
      const { escrow, alice } = await deploy();
      const futureDeadline = Math.floor(Date.now() / 1000) + 9999;
      await escrow.connect(alice).openJob(3, ethers.constants.HashZero, ethers.constants.AddressZero, 0, futureDeadline);
      await expect(escrow.connect(alice).cancelJob(1))
        .to.be.revertedWith("before_deadline");
    });

    it("reverts on jobs with no deadline (deadline = 0)", async function () {
      const { escrow, alice } = await deploy();
      await escrow.connect(alice).openJob(3, ethers.constants.HashZero, ethers.constants.AddressZero, 0, 0);
      await expect(escrow.connect(alice).cancelJob(1))
        .to.be.revertedWith("before_deadline");
    });
  });
});
