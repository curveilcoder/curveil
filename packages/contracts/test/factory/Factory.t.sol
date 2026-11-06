// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {LaunchBase} from "../launch/LaunchBase.sol";
import {LaunchFactory, ILaunchpadRegistry} from "../../src/launch/LaunchFactory.sol";
import {BondingCurve} from "../../src/launch/BondingCurve.sol";
import {LaunchpadRegistry, ITemplateCount} from "../../src/factory/LaunchpadRegistry.sol";
import {FeeSplitter} from "../../src/factory/FeeSplitter.sol";

contract FactoryTest is LaunchBase {
    LaunchpadRegistry internal pads;
    address internal opAdmin = makeAddr("opAdmin");
    address internal r1 = makeAddr("r1");
    address internal r2 = makeAddr("r2");
    address internal r3 = makeAddr("r3");

    function setUp() public override {
        super.setUp();
        pads = new LaunchpadRegistry(address(this), ITemplateCount(address(templates)), 5000);
        launchFactory.setLaunchpads(ILaunchpadRegistry(address(pads)));
    }

    function _register(string memory slug, uint16 share) internal returns (address op) {
        address[] memory rs = new address[](2);
        rs[0] = r1;
        rs[1] = r2;
        uint16[] memory ws = new uint16[](2);
        ws[0] = 7000;
        ws[1] = 3000;
        vm.prank(opAdmin);
        op = pads.register(
            slug, "data:application/json,{\"name\":\"Petal Pad\"}", share, uint64(1 << standardId), rs, ws
        );
    }

    function _params(address operator) internal view returns (LaunchFactory.CreateParams memory) {
        return LaunchFactory.CreateParams({
            templateId: standardId,
            name: "Pad Coin",
            symbol: "PAD",
            metadataURI: "",
            creatorRecipient: creatorFees,
            operator: operator,
            initialBuy: 0,
            minTokensOut: 0,
            deadline: block.timestamp
        });
    }

    function _expectBlocked(address operator) internal {
        LaunchFactory.CreateParams memory p = _params(operator);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchFactory.OperatorNotAllowed.selector, operator));
        launchFactory.createLaunch(p);
    }

    function _createWith(address operator) internal returns (BondingCurve curve) {
        LaunchFactory.CreateParams memory p = _params(operator);
        vm.prank(creator);
        (, address c) = launchFactory.createLaunch(p);
        curve = BondingCurve(c);
        vm.prank(alice);
        usdg.approve(c, type(uint256).max);
    }

    // ------------------------------------------------------------------ registry

    function test_register_predictsAddressAndStoresTerms() public {
        address predicted = pads.predictOperator("petal-pad");
        address op = _register("petal-pad", 4000);
        assertEq(op, predicted);
        assertEq(pads.operatorBySlug(keccak256("petal-pad")), op);
        (bool ok, uint16 share) = pads.operatorTerms(op, standardId);
        assertTrue(ok);
        assertEq(share, 4000);
        (bool other,) = pads.operatorTerms(op, standardId + 1);
        assertFalse(other);
        assertEq(FeeSplitter(op).registry(), address(pads));
    }

    function test_register_rejectsBadInput() public {
        _register("petal-pad", 1000);
        address[] memory rs = new address[](1);
        rs[0] = r1;
        uint16[] memory ws = new uint16[](1);
        ws[0] = 10_000;
        vm.expectRevert(LaunchpadRegistry.SlugTaken.selector);
        pads.register("petal-pad", "", 0, 1, rs, ws);
        vm.expectRevert(LaunchpadRegistry.BadSlug.selector);
        pads.register("Petal", "", 0, 1, rs, ws);
        vm.expectRevert(LaunchpadRegistry.BadSlug.selector);
        pads.register("-ab", "", 0, 1, rs, ws);
        vm.expectRevert(LaunchpadRegistry.ShareTooHigh.selector);
        pads.register("too-much", "", 5001, 1, rs, ws);
        vm.expectRevert(LaunchpadRegistry.BadTemplates.selector);
        pads.register("no-templates", "", 0, 0, rs, ws);
        vm.expectRevert(LaunchpadRegistry.BadTemplates.selector);
        pads.register("missing-template", "", 0, 2, rs, ws); // only template 0 exists
        ws[0] = 9999;
        vm.expectRevert(FeeSplitter.BadRecipients.selector);
        pads.register("bad-weights", "", 0, 1, rs, ws);
    }

    function test_onlyAdminCanConfigure() public {
        address op = _register("petal-pad", 1000);
        vm.expectRevert(LaunchpadRegistry.NotAdmin.selector);
        pads.setShare(op, 2000);
        vm.expectRevert(LaunchpadRegistry.NotAdmin.selector);
        pads.setBrand(op, "x");
        vm.prank(opAdmin);
        pads.setShare(op, 2000);
        (, uint16 share) = pads.operatorTerms(op, standardId);
        assertEq(share, 2000);
        vm.prank(opAdmin);
        pads.transferAdmin(op, bob);
        vm.prank(bob);
        pads.acceptAdmin(op);
        assertEq(pads.operatorInfo(op).admin, bob);
        vm.prank(opAdmin);
        vm.expectRevert(LaunchpadRegistry.NotAdmin.selector);
        pads.setActive(op, false);
    }

    // ------------------------------------------------------------------ launches

    function test_launchWithOperator_paysOperatorShareToSplitter() public {
        address op = _register("petal-pad", 4000);
        BondingCurve curve = _createWith(op);
        assertEq(curve.operator(), op);
        assertEq(curve.operatorShareBps(), 4000);
        vm.prank(alice);
        curve.buy(10_000e6, 0, alice, block.timestamp);
        uint256 fee = 100e6; // 1% of 10,000
        assertEq(curve.creatorFees(), fee / 2);
        assertEq(curve.operatorFees(), (fee / 2) * 4000 / 10_000);
        assertEq(curve.protocolFees(), fee / 2 - (fee / 2) * 4000 / 10_000);

        address[] memory curves = new address[](1);
        curves[0] = address(curve);
        uint256 got = FeeSplitter(op).collect(curves, address(usdg));
        assertEq(got, 20e6);
        assertEq(FeeSplitter(op).owed(address(usdg), r1), 14e6);
        assertEq(FeeSplitter(op).owed(address(usdg), r2), 6e6);
        FeeSplitter(op).release(address(usdg), r1);
        assertEq(usdg.balanceOf(r1), 14e6);
        assertEq(FeeSplitter(op).unpaid(address(usdg)), 6e6);
    }

    function test_operatorCannotChangeLiveLaunch() public {
        address op = _register("petal-pad", 4000);
        BondingCurve curve = _createWith(op);
        vm.startPrank(opAdmin);
        pads.setShare(op, 0);
        pads.setActive(op, false);
        vm.stopPrank();
        pads.setMaxShare(0);
        pads.setSuspended(op, true);
        assertEq(curve.operatorShareBps(), 4000);
        vm.prank(alice);
        curve.buy(1_000e6, 0, alice, block.timestamp);
        assertEq(curve.operatorFees(), 2e6);
    }

    function test_inactiveSuspendedOrDisallowed_blocksNewLaunches() public {
        address op = _register("petal-pad", 4000);
        vm.prank(opAdmin);
        pads.setActive(op, false);
        _expectBlocked(op);
        vm.prank(opAdmin);
        pads.setActive(op, true);
        pads.setSuspended(op, true);
        _expectBlocked(op);
        pads.setSuspended(op, false);
        _createWith(op);
        _expectBlocked(alice);
    }

    function test_lowerCapAppliesToNewLaunchesOnly() public {
        address op = _register("petal-pad", 4000);
        BondingCurve before = _createWith(op);
        pads.setMaxShare(1000);
        BondingCurve afterCap = _createWith(op);
        assertEq(before.operatorShareBps(), 4000);
        assertEq(afterCap.operatorShareBps(), 1000);
    }

    // ------------------------------------------------------------------ splitter

    function test_setRecipients_keepsWhatOldRecipientsWereOwed() public {
        address op = _register("petal-pad", 5000);
        BondingCurve curve = _createWith(op);
        vm.prank(alice);
        curve.buy(10_000e6, 0, alice, block.timestamp);
        curve.claimFees(BondingCurve.Bucket.Operator); // 25 USDG arrives, not yet allocated

        address[] memory rs = new address[](1);
        rs[0] = r3;
        uint16[] memory ws = new uint16[](1);
        ws[0] = 10_000;
        address[] memory toks = new address[](1);
        toks[0] = address(usdg);
        vm.expectRevert(FeeSplitter.NotRegistry.selector);
        FeeSplitter(op).setRecipients(rs, ws, toks);
        vm.prank(opAdmin);
        pads.setRecipients(op, rs, ws, toks);

        assertEq(FeeSplitter(op).owed(address(usdg), r1), 17.5e6);
        assertEq(FeeSplitter(op).owed(address(usdg), r2), 7.5e6);
        vm.prank(alice);
        curve.buy(1_000e6, 0, alice, block.timestamp);
        curve.claimFees(BondingCurve.Bucket.Operator);
        FeeSplitter(op).distribute(address(usdg));
        assertEq(FeeSplitter(op).owed(address(usdg), r3), 2.5e6);
        FeeSplitter(op).release(address(usdg), r2);
        assertEq(usdg.balanceOf(r2), 7.5e6);
    }

    function test_collect_skipsOtherOperatorsCurves() public {
        address op = _register("petal-pad", 5000);
        address other = _register("other-pad", 5000);
        BondingCurve mine = _createWith(op);
        BondingCurve theirs = _createWith(other);
        vm.startPrank(alice);
        mine.buy(1_000e6, 0, alice, block.timestamp);
        theirs.buy(1_000e6, 0, alice, block.timestamp);
        vm.stopPrank();
        address[] memory curves = new address[](2);
        curves[0] = address(mine);
        curves[1] = address(theirs);
        assertEq(FeeSplitter(op).collect(curves, address(usdg)), 2.5e6);
        assertEq(theirs.operatorFees(), 2.5e6);
    }

    function test_splitterCannotBeReinitialised() public {
        address op = _register("petal-pad", 5000);
        address[] memory rs = new address[](1);
        rs[0] = alice;
        uint16[] memory ws = new uint16[](1);
        ws[0] = 10_000;
        vm.expectRevert(FeeSplitter.AlreadyInitialised.selector);
        FeeSplitter(op).initialise(alice, rs, ws);
        FeeSplitter impl = FeeSplitter(pads.splitterImplementation());
        vm.expectRevert(FeeSplitter.AlreadyInitialised.selector);
        impl.initialise(alice, rs, ws);
    }

    /// Allocations always add up to what arrived, never more, whatever the weights and amounts.
    function testFuzz_distributeIsExact(uint16 w1, uint16 w2, uint96 a, uint96 b) public {
        w1 = uint16(bound(w1, 1, 9998));
        w2 = uint16(bound(w2, 1, 9999 - w1));
        address[] memory rs = new address[](3);
        rs[0] = r1;
        rs[1] = r2;
        rs[2] = r3;
        uint16[] memory ws = new uint16[](3);
        ws[0] = w1;
        ws[1] = w2;
        ws[2] = 10_000 - w1 - w2;
        address op = pads.register("fuzz-pad", "", 0, 1, rs, ws);
        FeeSplitter s = FeeSplitter(op);
        usdg.mint(op, a);
        s.distribute(address(usdg));
        usdg.mint(op, b);
        s.distribute(address(usdg));
        uint256 sum = s.owed(address(usdg), r1) + s.owed(address(usdg), r2) + s.owed(address(usdg), r3);
        assertEq(sum, uint256(a) + b);
        assertEq(s.unpaid(address(usdg)), sum);
        s.release(address(usdg), r1);
        s.release(address(usdg), r2);
        s.release(address(usdg), r3);
        assertEq(usdg.balanceOf(op), 0);
        assertEq(s.totalDistributed(address(usdg)), uint256(a) + b);
    }
}
