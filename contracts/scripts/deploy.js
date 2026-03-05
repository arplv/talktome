/* eslint-disable no-console */
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  const name = process.env.TTM_NAME ?? "TalkToMe";
  const symbol = process.env.TTM_SYMBOL ?? "TTM";
  const cap = hre.ethers.utils.parseEther(process.env.TTM_CAP ?? "1000000"); // 1,000,000 TTM
  const baseReward = hre.ethers.utils.parseEther(process.env.TTM_BASE_REWARD ?? "10"); // 10 TTM per complexity

  const treasury = process.env.TTM_TREASURY ?? deployer.address;
  const openFee = hre.ethers.utils.parseEther(process.env.TTM_OPEN_FEE ?? "0"); // set >0 to require TTM to open jobs

  const Token = await hre.ethers.getContractFactory("TalkToMeToken");
  const token = await Token.deploy(name, symbol, cap, baseReward);
  await token.deployed();

  const Escrow = await hre.ethers.getContractFactory("TalkToMeEscrow");
  const escrow = await Escrow.deploy(token.address, treasury, openFee);
  await escrow.deployed();

  await (await token.setMinter(escrow.address)).wait();

  console.log(
    JSON.stringify(
      {
        network: hre.network.name,
        deployer: deployer.address,
        treasury,
        token: token.address,
        escrow: escrow.address,
        openFee: openFee.toString(),
        baseReward: baseReward.toString(),
        cap: cap.toString()
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

