// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Spender {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract SPATAgentUsage {
    enum ActionType { MakeTask, RunWorkflow, UseService }

    IERC20Spender public immutable spat;
    address public immutable treasury;
    address public owner;

    mapping(ActionType => uint256) public actionPrice;

    event Charged(address indexed user, ActionType indexed actionType, uint256 amount, bytes32 requestId);
    event PriceSet(ActionType indexed actionType, uint256 amount);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address owner_, address spat_, address treasury_) {
        require(owner_ != address(0), "BAD_OWNER");
        require(spat_ != address(0), "BAD_TOKEN");
        require(treasury_ != address(0), "BAD_TREASURY");
        owner = owner_;
        spat = IERC20Spender(spat_);
        treasury = treasury_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function setPrice(ActionType actionType, uint256 amount) external onlyOwner {
        actionPrice[actionType] = amount;
        emit PriceSet(actionType, amount);
    }

    function charge(ActionType actionType, bytes32 requestId) external {
        uint256 amount = actionPrice[actionType];
        require(amount > 0, "PRICE_NOT_SET");
        require(spat.transferFrom(msg.sender, treasury, amount), "TRANSFER_FROM_FAIL");
        emit Charged(msg.sender, actionType, amount, requestId);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "BAD_OWNER");
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }
}
