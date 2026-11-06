// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @title TestFaucet
/// @notice TESTNET ONLY. Mints a fixed amount of each test token to a caller once per cooldown.
contract TestFaucet is Ownable2Step {
    struct Drip {
        uint256 amount;
        bool enabled;
    }

    uint256 public cooldown;
    mapping(address token => Drip) public drips;
    mapping(address account => mapping(address token => uint256)) public lastClaim;

    event DripConfigured(address indexed token, uint256 amount, bool enabled);
    event CooldownSet(uint256 cooldown);
    event Claimed(address indexed account, address indexed token, uint256 amount);

    error DripDisabled(address token);
    error CoolingDown(address token, uint256 availableAt);

    constructor(address initialOwner, uint256 cooldown_) Ownable(initialOwner) {
        cooldown = cooldown_;
        emit CooldownSet(cooldown_);
    }

    function configure(address token, uint256 amount, bool enabled) external onlyOwner {
        drips[token] = Drip(amount, enabled);
        emit DripConfigured(token, amount, enabled);
    }

    function setCooldown(uint256 cooldown_) external onlyOwner {
        cooldown = cooldown_;
        emit CooldownSet(cooldown_);
    }

    function availableAt(address account, address token) public view returns (uint256) {
        uint256 last = lastClaim[account][token];
        return last == 0 ? 0 : last + cooldown;
    }

    function claim(address token) public {
        Drip memory d = drips[token];
        if (!d.enabled) revert DripDisabled(token);
        uint256 at = availableAt(msg.sender, token);
        if (at != 0 && block.timestamp < at) revert CoolingDown(token, at);
        lastClaim[msg.sender][token] = block.timestamp;
        IMintable(token).mint(msg.sender, d.amount);
        emit Claimed(msg.sender, token, d.amount);
    }

    function claimMany(address[] calldata tokens) external {
        for (uint256 i; i < tokens.length; ++i) {
            claim(tokens[i]);
        }
    }
}
