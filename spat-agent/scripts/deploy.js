import { ethers } from "hardhat";

async function main() {
  const token = process.env.SPAT_TOKEN;
  const owner = process.env.EOA_OWNER || "0x4e26fc6eb05a1cdbd762609fde9958e5b8cc754d";

  if (!token) throw new Error("Missing SPAT_TOKEN env");

  const Factory = await ethers.getContractFactory("SPATAgentVault");
  const vault = await Factory.deploy(token, owner);
  await vault.waitForDeployment();

  console.log("SPATAgentVault deployed:", await vault.getAddress());
  console.log("token:", token);
  console.log("owner:", owner);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
