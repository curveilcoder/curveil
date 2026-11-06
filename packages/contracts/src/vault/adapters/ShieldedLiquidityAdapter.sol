// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {CurveilRouter} from "../../markets/CurveilRouter.sol";
import {DammFactory} from "../../markets/DammFactory.sol";
import {DammPool} from "../../markets/DammPool.sol";
import {DlmmFactory} from "../../markets/DlmmFactory.sol";
import {DlmmPair} from "../../markets/DlmmPair.sol";
import {ICurveilPool} from "../../markets/interfaces/ICurveilPool.sol";
import {IShieldedAdapter} from "../interfaces/IShieldedAdapter.sol";
import {PositionHolder} from "./PositionHolder.sol";

/// @notice Shielded liquidity (whitepaper section 9). Each entry opens one position: a fresh
///         holder clone owns the position's DAMM LP shares or DLMM bin shares, so the pool or pair
///         accounts its fees exactly. The user receives a share note of UNITS units. Units can be
///         sent privately with the pool's `transfer`, and an exit redeems any part of them, pro
///         rata, for the position's assets plus its fees, back into notes or to a public address.
/// @dev params = abi.encode(uint8 op, bytes body). Bodies: DammEntry, DlmmEntry, Exit.
///      Position ids are chosen by the client (random), so the share note's resource is known
///      before proving. Fees are realised on exit; unclaimed fees travel with transferred units.
contract ShieldedLiquidityAdapter is IShieldedAdapter {
    using SafeERC20 for IERC20;

    uint8 public constant OP_ENTER_DAMM = 1;
    uint8 public constant OP_ENTER_DLMM = 2;
    uint8 public constant OP_EXIT = 3;
    /// @notice Units carried by a new position's share note.
    uint128 public constant UNITS = 1e18;

    enum Kind {
        None,
        Damm,
        Dlmm
    }

    struct Position {
        Kind kind;
        address market;
        address holder;
        uint128 units;
        uint24[] ids;
    }

    /// @param min0 Least token0 the pool may take (as in a public deposit), min1 likewise.
    struct DammEntry {
        uint256 positionId;
        address market;
        uint256 min0;
        uint256 min1;
        uint256 minLiquidity;
    }

    struct DlmmEntry {
        uint256 positionId;
        address market;
        uint24 activeIdExpected;
        uint24 idSlippage;
        int256[] deltaIds;
        uint256[] distributionX;
        uint256[] distributionY;
    }

    struct Exit {
        uint256 positionId;
        uint256 min0;
        uint256 min1;
    }

    address public immutable pool;
    CurveilRouter public immutable router;
    DammFactory public immutable damm;
    DlmmFactory public immutable dlmm;
    address public immutable holderImplementation;

    mapping(uint256 positionId => Position) internal _positions;

    event PositionOpened(
        uint256 indexed positionId, Kind kind, address indexed market, address holder, uint256 used0, uint256 used1
    );
    event PositionReduced(
        uint256 indexed positionId, uint256 units, uint256 remainingUnits, uint256 amount0, uint256 amount1
    );

    error OnlyPool();
    error UnknownOp(uint8 op);
    error UnknownMarket(address market);
    error UnknownPosition(uint256 positionId);
    error PositionExists(uint256 positionId);
    error BadInputs();
    error Slippage();

    constructor(address pool_, CurveilRouter router_) {
        pool = pool_;
        router = router_;
        damm = router_.damm();
        dlmm = router_.dlmm();
        PositionHolder impl = new PositionHolder();
        impl.initialize(); // the implementation itself can never be driven by anyone else
        holderImplementation = address(impl);
    }

    function execute(bytes calldata params, Input[] calldata inputs) external returns (Output[] memory) {
        if (msg.sender != pool) revert OnlyPool();
        (uint8 op, bytes memory body) = abi.decode(params, (uint8, bytes));
        if (op == OP_ENTER_DAMM) return _enterDamm(abi.decode(body, (DammEntry)), inputs);
        if (op == OP_ENTER_DLMM) return _enterDlmm(abi.decode(body, (DlmmEntry)), inputs);
        if (op == OP_EXIT) return _exit(abi.decode(body, (Exit)), inputs);
        revert UnknownOp(op);
    }

    // ---------------------------------------------------------------- views

    function positionOf(uint256 positionId) external view returns (Position memory) {
        return _positions[positionId];
    }

    /// @notice What exiting `units` of a position would return now, fees included, in the
    ///         market's token order (DAMM token0/token1, DLMM X/Y).
    function previewExit(uint256 positionId, uint256 units) external view returns (uint256 out0, uint256 out1) {
        Position storage p = _positions[positionId];
        uint256 total = p.units;
        if (p.kind == Kind.None || units == 0 || units > total) return (0, 0);
        uint256 fee0;
        uint256 fee1;
        if (p.kind == Kind.Damm) {
            DammPool m = DammPool(p.market);
            uint256 lp = m.balanceOf(p.holder);
            uint256 lpOut = _part(lp, units, total);
            (uint128 r0, uint128 r1) = m.getReserves();
            uint256 supply = m.totalSupply();
            if (supply != 0) {
                out0 = (lpOut * r0) / supply;
                out1 = (lpOut * r1) / supply;
            }
            (fee0, fee1) = m.pendingFees(p.holder);
        } else {
            DlmmPair m = DlmmPair(p.market);
            for (uint256 i = 0; i < p.ids.length; i++) {
                uint256 s = _part(m.getPosition(p.ids[i], p.holder).shares, units, total);
                if (s == 0) continue;
                (uint256 x, uint256 y) = m.previewWithdraw(p.ids[i], s);
                out0 += x;
                out1 += y;
            }
            (fee0, fee1) = m.pendingFees(p.holder, p.ids);
        }
        (address t0, address t1) = ICurveilPool(p.market).tokens();
        out0 += _part(fee0 + IERC20(t0).balanceOf(p.holder), units, total);
        out1 += _part(fee1 + IERC20(t1).balanceOf(p.holder), units, total);
    }

    // ---------------------------------------------------------------- entries

    function _enterDamm(DammEntry memory e, Input[] calldata inputs) private returns (Output[] memory) {
        if (!damm.isPool(e.market)) revert UnknownMarket(e.market);
        (address t0, address t1) = ICurveilPool(e.market).tokens();
        (uint256 a0, uint256 a1) = _fungibleAmounts(inputs, t0, t1);
        address holder = _newHolder(e.positionId);
        IERC20(t0).forceApprove(address(router), a0);
        IERC20(t1).forceApprove(address(router), a1);
        (uint256 used0, uint256 used1, uint256 liquidity) =
            router.addLiquidityDamm(CurveilRouter.DammDeposit(t0, t1, a0, a1, e.min0, e.min1, holder, block.timestamp));
        if (liquidity == 0 || liquidity < e.minLiquidity) revert Slippage();
        IERC20(t0).forceApprove(address(router), 0);
        IERC20(t1).forceApprove(address(router), 0);
        _record(e.positionId, Kind.Damm, e.market, holder, new uint24[](0));
        emit PositionOpened(e.positionId, Kind.Damm, e.market, holder, used0, used1);
        return _entryOutputs(e.positionId, t0, a0 - used0, t1, a1 - used1);
    }

    function _enterDlmm(DlmmEntry memory e, Input[] calldata inputs) private returns (Output[] memory) {
        if (!dlmm.isPool(e.market)) revert UnknownMarket(e.market);
        (address tx_, address ty) = ICurveilPool(e.market).tokens();
        (uint256 ax, uint256 ay) = _fungibleAmounts(inputs, tx_, ty);
        address holder = _newHolder(e.positionId);
        (uint256 usedX, uint256 usedY) = _depositDlmm(e, holder, ax, ay, tx_, ty);
        emit PositionOpened(e.positionId, Kind.Dlmm, e.market, holder, usedX, usedY);
        return _entryOutputs(e.positionId, tx_, ax - usedX, ty, ay - usedY);
    }

    function _depositDlmm(DlmmEntry memory e, address holder, uint256 ax, uint256 ay, address tx_, address ty)
        private
        returns (uint256 usedX, uint256 usedY)
    {
        IERC20(tx_).forceApprove(address(router), ax);
        IERC20(ty).forceApprove(address(router), ay);
        uint256[] memory rawIds;
        uint256[] memory minted;
        (usedX, usedY, rawIds, minted) = router.addLiquidityDlmm(
            CurveilRouter.DlmmDeposit(
                e.market,
                ax,
                ay,
                e.activeIdExpected,
                e.idSlippage,
                e.deltaIds,
                e.distributionX,
                e.distributionY,
                holder,
                block.timestamp
            )
        );
        IERC20(tx_).forceApprove(address(router), 0);
        IERC20(ty).forceApprove(address(router), 0);
        uint24[] memory ids = new uint24[](rawIds.length);
        uint256 k;
        for (uint256 i = 0; i < rawIds.length; i++) {
            if (minted[i] != 0) ids[k++] = uint24(rawIds[i]);
        }
        if (k == 0) revert Slippage();
        assembly ("memory-safe") {
            mstore(ids, k)
        }
        _record(e.positionId, Kind.Dlmm, e.market, holder, ids);
    }

    function _entryOutputs(uint256 positionId, address t0, uint256 refund0, address t1, uint256 refund1)
        private
        returns (Output[] memory outputs)
    {
        outputs = new Output[](3);
        outputs[0] = Output(address(0), positionId, UNITS);
        outputs[1] = _toPool(t0, refund0);
        outputs[2] = _toPool(t1, refund1);
    }

    // ---------------------------------------------------------------- exits

    function _exit(Exit memory e, Input[] calldata inputs) private returns (Output[] memory outputs) {
        if (inputs.length != 1 || inputs[0].token != address(0) || inputs[0].shareId != e.positionId) revert BadInputs();
        Position storage p = _positions[e.positionId];
        if (p.kind == Kind.None) revert UnknownPosition(e.positionId);
        uint256 units = inputs[0].amount;
        uint256 total = p.units;
        if (units == 0 || units > total) revert BadInputs();
        (uint256 out0, uint256 out1) = p.kind == Kind.Damm ? _exitDamm(p, units, total) : _exitDlmm(p, units, total);
        (address t0, address t1) = ICurveilPool(p.market).tokens();
        // Fees claimed now or earlier sit in the holder; the exiting units take their share.
        out0 += _sweep(p.holder, t0, units, total);
        out1 += _sweep(p.holder, t1, units, total);
        if (out0 < e.min0 || out1 < e.min1) revert Slippage();
        p.units = uint128(total - units);
        emit PositionReduced(e.positionId, units, total - units, out0, out1);
        outputs = new Output[](2);
        outputs[0] = Output(t0, 0, out0);
        outputs[1] = Output(t1, 0, out1);
    }

    function _exitDamm(Position storage p, uint256 units, uint256 total) private returns (uint256 a0, uint256 a1) {
        PositionHolder h = PositionHolder(p.holder);
        h.exec(p.market, abi.encodeCall(DammPool.claimFees, (p.holder)));
        uint256 lpOut = _part(IERC20(p.market).balanceOf(p.holder), units, total);
        if (lpOut == 0) return (0, 0);
        h.exec(p.market, abi.encodeCall(IERC20.transfer, (p.market, lpOut)));
        (a0, a1) = abi.decode(h.exec(p.market, abi.encodeCall(DammPool.burn, (pool))), (uint256, uint256));
    }

    function _exitDlmm(Position storage p, uint256 units, uint256 total) private returns (uint256 ax, uint256 ay) {
        PositionHolder h = PositionHolder(p.holder);
        uint24[] memory all = p.ids;
        h.exec(p.market, abi.encodeCall(DlmmPair.claimFees, (p.holder, all)));
        uint24[] memory ids = new uint24[](all.length);
        uint256[] memory take = new uint256[](all.length);
        uint256 k;
        for (uint256 i = 0; i < all.length; i++) {
            uint256 s = _part(DlmmPair(p.market).getPosition(all[i], p.holder).shares, units, total);
            if (s == 0) continue;
            ids[k] = all[i];
            take[k++] = s;
        }
        if (k == 0) return (0, 0);
        assembly ("memory-safe") {
            mstore(ids, k)
            mstore(take, k)
        }
        bytes memory r =
            h.exec(p.market, abi.encodeCall(DlmmPair.removeLiquidity, (pool, ids, take, 0, 0, block.timestamp)));
        (ax, ay) = abi.decode(r, (uint256, uint256));
    }

    // ---------------------------------------------------------------- internals

    function _fungibleAmounts(Input[] calldata inputs, address t0, address t1)
        private
        pure
        returns (uint256 a0, uint256 a1)
    {
        if (inputs.length == 0) revert BadInputs();
        for (uint256 i = 0; i < inputs.length; i++) {
            if (inputs[i].token == t0 && t0 != address(0)) a0 += inputs[i].amount;
            else if (inputs[i].token == t1 && t1 != address(0)) a1 += inputs[i].amount;
            else revert BadInputs();
        }
    }

    function _newHolder(uint256 positionId) private returns (address holder) {
        if (positionId == 0) revert BadInputs();
        if (_positions[positionId].kind != Kind.None) revert PositionExists(positionId);
        holder = Clones.clone(holderImplementation);
        PositionHolder(holder).initialize();
    }

    function _record(uint256 positionId, Kind kind, address market, address holder, uint24[] memory ids) private {
        Position storage p = _positions[positionId];
        p.kind = kind;
        p.market = market;
        p.holder = holder;
        p.units = UNITS;
        p.ids = ids;
    }

    function _toPool(address token, uint256 amount) private returns (Output memory) {
        if (amount != 0) IERC20(token).safeTransfer(pool, amount);
        return Output(token, 0, amount);
    }

    function _sweep(address holder, address token, uint256 units, uint256 total) private returns (uint256 amount) {
        amount = _part(IERC20(token).balanceOf(holder), units, total);
        if (amount != 0) PositionHolder(holder).exec(token, abi.encodeCall(IERC20.transfer, (pool, amount)));
    }

    /// @dev The last units out take everything left, so no dust is stranded.
    function _part(uint256 value, uint256 units, uint256 total) private pure returns (uint256) {
        return units == total ? value : (value * units) / total;
    }
}
