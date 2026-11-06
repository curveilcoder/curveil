// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TransferHelper} from "../src/shared/TransferHelper.sol";

/// Token that burns 1% on every transfer, like a fee-on-transfer asset.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {
        _mint(msg.sender, 1e24);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

contract PlainToken is ERC20 {
    constructor() ERC20("Plain", "PLN") {
        _mint(msg.sender, 1e24);
    }
}

contract Puller {
    function pull(IERC20 token, address from, uint256 amount) external {
        TransferHelper.pullExact(token, from, amount);
    }
}

contract TransferHelperTest is Test {
    Puller puller = new Puller();

    function testFuzz_plainTokenPullsExactAmount(uint256 amount) public {
        amount = bound(amount, 0, 1e24);
        PlainToken t = new PlainToken();
        t.approve(address(puller), amount);
        puller.pull(t, address(this), amount);
        assertEq(t.balanceOf(address(puller)), amount);
    }

    function test_feeOnTransferTokenIsRejected() public {
        FeeOnTransferToken t = new FeeOnTransferToken();
        t.approve(address(puller), 1000);
        vm.expectRevert(abi.encodeWithSelector(TransferHelper.ReceivedAmountMismatch.selector, address(t), 1000, 990));
        puller.pull(t, address(this), 1000);
    }
}
