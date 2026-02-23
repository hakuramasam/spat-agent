// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract SPATAgentUsage {
    using SafeERC20 for IERC20;

    enum ActionType {
        MakeTask,
        RunWorkflow,
        UseService
    }

    IERC20 public immutable spat;
    address public immutable treasury;
    address public owner;

    mapping(ActionType => uint256) public actionPrice;
    mapping(bytes32 => bool) public requestCharged;

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
        spat = IERC20(spat_);
        treasury = treasury_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function setPrice(ActionType actionType, uint256 amount) external onlyOwner {
        actionPrice[actionType] = amount;
        emit PriceSet(actionType, amount);
    }

    function charge(ActionType actionType, bytes32 requestId) external {
        require(!requestCharged[requestId], "REQUEST_ALREADY_CHARGED");

        uint256 amount = actionPrice[actionType];
        require(amount > 0, "PRICE_NOT_SET");

        requestCharged[requestId] = true;
        spat.safeTransferFrom(msg.sender, treasury, amount);

        emit Charged(msg.sender, actionType, amount, requestId);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "BAD_OWNER");
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }
}
