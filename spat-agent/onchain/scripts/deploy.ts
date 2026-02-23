import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });

async function main() {
  const owner = process.env.AGENT_OWNER_EOA;
  const spatToken = process.env.SPAT_TOKEN;

  if (!owner) throw new Error("Missing AGENT_OWNER_EOA in onchain/.env");
  if (!spatToken) throw new Error("Missing SPAT_TOKEN in onchain/.env");

  const Treasury = await ethers.getContractFactory("SPATAgentTreasury");
  const treasury = await Treasury.deploy(owner, spatToken);
  await treasury.waitForDeployment();

  const treasuryAddress = await treasury.getAddress();

  const Usage = await ethers.getContractFactory("SPATAgentUsage");
  const usage = await Usage.deploy(owner, spatToken, treasuryAddress);
  await usage.waitForDeployment();
  const usageAddress = await usage.getAddress();

  console.log("SPATAgentTreasury:", treasuryAddress);
  console.log("SPATAgentUsage:", usageAddress);

  console.log("Next: fund treasury with 500000 SPAT");
  console.log(
    `cast send ${spatToken} \"transfer(address,uint256)\" ${treasuryAddress} <AMOUNT_WEI> --private-key $FUNDER_PK --rpc-url $RPC_URL`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
