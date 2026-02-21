// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract SPATAgentTreasury {
    address public owner;
    IERC20 public immutable spat;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event Payout(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address owner_, address spat_) {
        require(owner_ != address(0), "BAD_OWNER");
        require(spat_ != address(0), "BAD_TOKEN");
        owner = owner_;
        spat = IERC20(spat_);
        emit OwnershipTransferred(address(0), owner_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "BAD_OWNER");
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    function payout(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "BAD_TO");
        require(spat.transfer(to, amount), "TRANSFER_FAIL");
        emit Payout(to, amount);
    }

    function balance() external view returns (uint256) {
        return spat.balanceOf(address(this));
    }
}
