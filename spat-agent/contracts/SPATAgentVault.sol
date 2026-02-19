// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title SPATAgentVault
 * @notice Vault for SPAT Agent operations. Controlled by an owner EOA.
 *         Supports authenticated spend requests via EIP-712 signatures.
 */
contract SPATAgentVault {
    error InvalidSigner();
    error ExpiredSignature();
    error InvalidNonce();
    error TransferFailed();

    IERC20 public immutable spatToken;
    address public owner;

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant SPEND_TYPEHASH = keccak256(
        "Spend(address to,uint256 amount,uint256 nonce,uint256 deadline,string purpose)"
    );

    mapping(uint256 => bool) public usedNonce;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Spent(address indexed to, uint256 amount, uint256 nonce, string purpose);
    event Deposited(address indexed from, uint256 amount);

    constructor(address token_, address owner_) {
        require(token_ != address(0), "token=0");
        require(owner_ != address(0), "owner=0");

        spatToken = IERC20(token_);
        owner = owner_;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("SPAT Agent Vault")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "not owner");
        require(newOwner != address(0), "newOwner=0");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function spend(
        address to,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        string calldata purpose,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp > deadline) revert ExpiredSignature();
        if (usedNonce[nonce]) revert InvalidNonce();

        bytes32 structHash = keccak256(
            abi.encode(
                SPEND_TYPEHASH,
                to,
                amount,
                nonce,
                deadline,
                keccak256(bytes(purpose))
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)
        );

        address recovered = ecrecover(digest, v, r, s);
        if (recovered != owner) revert InvalidSigner();

        usedNonce[nonce] = true;
        bool ok = spatToken.transfer(to, amount);
        if (!ok) revert TransferFailed();

        emit Spent(to, amount, nonce, purpose);
    }
}
