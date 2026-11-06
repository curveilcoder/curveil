// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Where protocol fees go when the config leaves a recipient at the zero address.
///         Fees then go to the module's ProtocolTreasury from deployments/<network>.governance.json,
///         which pays out only through the timelock, so only after a Safe vote and the public delay.
///         A config that names an address keeps it. Run DeployGovernance before the module scripts.
library FeeRecipients {
    using stdJson for string;

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// The configured address at `key`, or else the `module` treasury. Zero if neither exists.
    function treasury(string memory cfg, string memory network, string memory key, string memory module)
        internal
        view
        returns (address)
    {
        return _resolve(cfg, network, key, string.concat(".treasuries.", module));
    }

    /// The configured address at `key`, or else the timelock. For recipients that must make calls
    /// to collect what they are owed, such as LP locks in the LpEscrow, which only their
    /// beneficiary can claim. A ProtocolTreasury can only transfer tokens it holds, so it cannot
    /// claim a lock; the timelock can, with a Safe vote and the delay, sending it to a treasury.
    function timelock(string memory cfg, string memory network, string memory key) internal view returns (address) {
        return _resolve(cfg, network, key, ".timelock");
    }

    function _resolve(string memory cfg, string memory network, string memory key, string memory gkey)
        private
        view
        returns (address a)
    {
        a = cfg.readAddress(key);
        if (a != address(0)) return a;
        string memory path = string.concat("deployments/", network, ".governance.json");
        if (!vm.exists(path)) return address(0);
        string memory g = vm.readFile(path);
        if (g.readUint(".chainId") != block.chainid || !vm.keyExistsJson(g, gkey)) return address(0);
        a = g.readAddress(gkey);
        if (a.code.length == 0) return address(0);
    }
}
