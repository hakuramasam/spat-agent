// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SPATAgentUsage
/// @notice On-chain billing contract for the SPAT Agent.
///         Users call charge() after approving SPAT spend; backend verifies
///         the resulting Charged event before executing the paid action.
contract SPATAgentUsage is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // BUG FIX: enum order MUST match backend actionTypeMap
    // makeTask=0, runWorkflow=1, useService=2
    enum ActionType {
        MakeTask,    // 0
        RunWorkflow, // 1
        UseService   // 2
    }

    IERC20  public immutable spat;
    address public immutable treasury;
    address public owner;

    mapping(ActionType => uint256) public actionPrice;
    mapping(bytes32 => bool)       public requestCharged;

    event Charged(
        address indexed user,
        ActionType indexed actionType,
        uint256 amount,
        bytes32 requestId
    );
    event PriceSet(ActionType indexed actionType, uint256 amount);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    error NotOwner();
    error BadAddress();
    error RequestAlreadyCharged();
    error PriceNotSet();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address spat_, address treasury_) {
        if (owner_    == address(0)) revert BadAddress();
        if (spat_     == address(0)) revert BadAddress();
        if (treasury_ == address(0)) revert BadAddress();

        owner    = owner_;
        spat     = IERC20(spat_);
        treasury = treasury_;

        // Set default prices (can be updated via setPrice)
        // makeTask:    1 SPAT  (1e18)
        // runWorkflow: 3 SPAT  (3e18)
        // useService:  0.5 SPAT (5e17)
        actionPrice[ActionType.MakeTask]    = 1e18;
        actionPrice[ActionType.RunWorkflow] = 3e18;
        actionPrice[ActionType.UseService]  = 5e17;

        emit OwnershipTransferred(address(0), owner_);
    }

    /// @notice Set price for an action type (owner only)
    function setPrice(ActionType actionType, uint256 amount) external onlyOwner {
        actionPrice[actionType] = amount;
        emit PriceSet(actionType, amount);
    }

    /// @notice Charge the caller for an action.
    ///         Caller must have approved this contract to spend `actionPrice[actionType]` SPAT.
    /// @param actionType  The action being paid for
    /// @param requestId   Unique request ID (prevents double-charge)
    function charge(ActionType actionType, bytes32 requestId) external nonReentrant {
        if (requestCharged[requestId]) revert RequestAlreadyCharged();

        uint256 amount = actionPrice[actionType];
        if (amount == 0) revert PriceNotSet();

        requestCharged[requestId] = true;
        spat.safeTransferFrom(msg.sender, treasury, amount);

        emit Charged(msg.sender, actionType, amount, requestId);
    }

    /// @notice Convenience view: returns all action prices in order
    function getPrices()
        external
        view
        returns (uint256 makeTask, uint256 runWorkflow, uint256 useService)
    {
        return (
            actionPrice[ActionType.MakeTask],
            actionPrice[ActionType.RunWorkflow],
            actionPrice[ActionType.UseService]
        );
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert BadAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }
}
