import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

export default {
  solidity: "0.8.20",
  networks: {
    mainnet: {
      url: process.env.RPC_URL || "",
      accounts: process.env.DEPLOYER_PK ? [process.env.DEPLOYER_PK] : []
    }
  }
};
