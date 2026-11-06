// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title CurveilLaunchToken
/// @notice Fixed-supply ERC-20 created by the LaunchFactory. The whole supply is minted once
///         at creation. There is no owner, no further minting, no pausing, no blocklist and
///         no way to move tokens without the holder's approval.
contract CurveilLaunchToken is ERC20 {
    /// @notice Content-addressed metadata (description, image, links) chosen by the creator.
    string public metadataURI;
    address public immutable launchFactory;

    constructor(string memory name_, string memory symbol_, string memory uri_, uint256 supply, address recipient)
        ERC20(name_, symbol_)
    {
        metadataURI = uri_;
        launchFactory = msg.sender;
        _mint(recipient, supply);
    }
}
