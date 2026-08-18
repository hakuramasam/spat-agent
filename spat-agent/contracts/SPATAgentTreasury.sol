// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SPATAgentTreasury
/// @notice Holds SPAT funds for the agent.
///         Controlled by an owner EOA (or multisig).
///         Usage contract transfers SPAT here; owner can payout to service wallets.
contract SPATAgentTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public owner;
    IERC20  public immutable spat;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event Payout(address indexed to, uint256 amount);
    // BUG FIX: added ETH recovery event
    event EthRecovered(address indexed to, uint256 amount);

    error NotOwner();
    error BadAddress();
    error InsufficientBalance();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address spat_) {
        if (owner_ == address(0)) revert BadAddress();
        if (spat_  == address(0)) revert BadAddress();
        owner = owner_;
        spat  = IERC20(spat_);
        emit OwnershipTransferred(address(0), owner_);
    }

    /// @notice Transfer SPAT to a recipient (owner only)
    function payout(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert BadAddress();
        if (spat.balanceOf(address(this)) < amount) revert InsufficientBalance();
        spat.safeTransfer(to, amount);
        emit Payout(to, amount);
    }

    /// @notice Current SPAT balance of this treasury
    function balance() external view returns (uint256) {
        return spat.balanceOf(address(this));
    }

    /// @notice Recover any ETH accidentally sent here (owner only)
    function recoverEth(address payable to) external onlyOwner nonReentrant {
        if (to == address(0)) revert BadAddress();
        uint256 amt = address(this).balance;
        if (amt == 0) revert InsufficientBalance();
        (bool ok,) = to.call{value: amt}("");
        require(ok, "ETH transfer failed");
        emit EthRecovered(to, amt);
    }

    /// @notice Recover other ERC-20 tokens accidentally sent here (owner only)
    function recoverToken(address token, address to, uint256 amount) external onlyOwner {
        if (to    == address(0)) revert BadAddress();
        if (token == address(spat)) revert BadAddress(); // use payout() for SPAT
        IERC20(token).safeTransfer(to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert BadAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    receive() external payable {}
}
