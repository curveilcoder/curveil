// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IShieldedAdapter} from "../interfaces/IShieldedAdapter.sol";
import {PerpEngine} from "../../perps/PerpEngine.sol";
import {OrderManager} from "../../perps/OrderManager.sol";

/// @notice Shielded perps (whitepaper section 10). Collateral comes from vault notes and the
///         position's owner of record is this adapter; who controls it is a claim note of one
///         unit, kept in the vault. Every action on the position spends the claim note (proving
///         ownership) and issues a fresh one, so actions cannot be linked to a wallet.
///
///         Money the engine sends for a position (a cancelled request's refund, close proceeds,
///         a filled take-profit or stop-loss) waits here until the claim holder collects it into
///         a note. A claim only ever collects what the engine has paid out for its position and
///         the claim has not collected yet, so a liquidated position leaves nothing to redeem.
///
///         Fees for the broadcaster: actions that spend only the claim may add a USDG leg, which
///         pays the fee and comes back as a note; a collection pays it from its output. A request
///         nobody executes in time is cancelled through the engine by anyone (normally the
///         keeper), and its refund is collected like any other payment.
/// @dev params = abi.encode(uint8 op, bytes body); every body starts with the claim id. Claim ids
///      are chosen by the client (random), so the claim note's resource is known before proving.
///      Outputs, in order: the claim note (when the claim stays alive), then USDG: always for a
///      collection (possibly zero), and for other actions only when a USDG leg is returned.
contract ShieldedPerpsAdapter is IShieldedAdapter {
    using SafeERC20 for IERC20;

    uint8 public constant OP_OPEN = 1;
    uint8 public constant OP_CLOSE = 2;
    uint8 public constant OP_ADD_COLLATERAL = 3;
    uint8 public constant OP_PLACE_ORDER = 4;
    uint8 public constant OP_CANCEL_ORDER = 5;
    uint8 public constant OP_COLLECT = 6;
    /// @notice Units carried by a claim note.
    uint256 public constant CLAIM_UNITS = 1;

    struct Open {
        uint256 claimId;
        uint32 market;
        bool isLong;
        uint128 size;
        uint128 collateral;
        uint256 acceptablePrice;
        uint128 executionFee;
    }

    struct Close {
        uint256 claimId;
        uint128 size;
        uint256 acceptablePrice;
        uint128 executionFee;
    }

    struct PlaceOrder {
        uint256 claimId;
        OrderManager.Kind kind;
        uint256 triggerPrice;
        uint128 size;
        uint256 acceptablePrice;
        uint128 executionFee;
        uint64 expiresAt;
    }

    struct CancelOrder {
        uint256 claimId;
        uint256 orderId;
    }

    /// @param keep Whether the claim stays alive: required while the position is waiting to
    ///        open or open, refused once it is closed, liquidated or cancelled.
    struct Collect {
        uint256 claimId;
        bool keep;
    }

    struct Claim {
        uint256 positionId;
        uint256 collected;
    }

    address public immutable pool;
    PerpEngine public immutable engine;
    OrderManager public immutable orders;
    IERC20 public immutable usdg;

    mapping(uint256 claimId => Claim) internal _claims;

    event ClaimOpened(uint256 indexed claimId, uint256 indexed positionId, uint256 requestId);
    event ClaimCollected(uint256 indexed claimId, uint256 indexed positionId, uint256 amount, bool kept);

    error OnlyPool();
    error UnknownOp(uint8 op);
    error BadInputs();
    error ClaimExists(uint256 claimId);
    error UnknownClaim(uint256 claimId);
    error NotThisPosition();
    error KeepMismatch(bool live);

    constructor(address pool_, PerpEngine engine_, OrderManager orders_) {
        pool = pool_;
        engine = engine_;
        orders = orders_;
        usdg = engine_.usdg();
    }

    function execute(bytes calldata params, Input[] calldata inputs) external returns (Output[] memory) {
        if (msg.sender != pool) revert OnlyPool();
        (uint8 op, bytes memory body) = abi.decode(params, (uint8, bytes));
        if (op == OP_OPEN) return _open(abi.decode(body, (Open)), inputs);
        (uint256 claimId, uint256 usdgIn) = _claimInputs(inputs, abi.decode(body, (uint256)));
        uint256 positionId = _claims[claimId].positionId;
        if (op == OP_COLLECT) {
            if (usdgIn != 0) revert BadInputs();
            return _collect(abi.decode(body, (Collect)), positionId);
        }
        if (op == OP_CLOSE) {
            Close memory c = abi.decode(body, (Close));
            engine.requestClose(positionId, c.size, c.acceptablePrice, c.executionFee);
        } else if (op == OP_ADD_COLLATERAL) {
            if (usdgIn == 0) revert BadInputs();
            usdg.forceApprove(address(engine), usdgIn);
            engine.addCollateral(positionId, uint128(usdgIn));
            usdgIn = 0;
        } else if (op == OP_PLACE_ORDER) {
            PlaceOrder memory o = abi.decode(body, (PlaceOrder));
            orders.place(positionId, o.kind, o.triggerPrice, o.size, o.acceptablePrice, o.executionFee, o.expiresAt);
        } else if (op == OP_CANCEL_ORDER) {
            CancelOrder memory c = abi.decode(body, (CancelOrder));
            if (orders.order(c.orderId).positionId != positionId) revert NotThisPosition();
            orders.cancel(c.orderId);
        } else {
            revert UnknownOp(op);
        }
        return _outputs(claimId, true, usdgIn, usdgIn != 0);
    }

    // ---------------------------------------------------------------- views

    function claim(uint256 claimId) external view returns (Claim memory) {
        return _claims[claimId];
    }

    /// @notice USDG the claim can collect now.
    function collectable(uint256 claimId) public view returns (uint256) {
        Claim memory c = _claims[claimId];
        if (c.positionId == 0) return 0;
        return engine.paidOut(c.positionId) - c.collected;
    }

    // ---------------------------------------------------------------- ops

    function _open(Open memory o, Input[] calldata inputs) private returns (Output[] memory) {
        if (o.claimId == 0) revert BadInputs();
        if (_claims[o.claimId].positionId != 0) revert ClaimExists(o.claimId);
        uint256 amount;
        for (uint256 i = 0; i < inputs.length; i++) {
            if (inputs[i].token != address(usdg)) revert BadInputs();
            amount += inputs[i].amount;
        }
        if (amount != uint256(o.collateral) + o.executionFee) revert BadInputs();
        usdg.forceApprove(address(engine), amount);
        (uint256 requestId, uint256 positionId) =
            engine.requestOpen(o.market, o.isLong, o.size, o.collateral, o.acceptablePrice, o.executionFee);
        _claims[o.claimId].positionId = positionId;
        emit ClaimOpened(o.claimId, positionId, requestId);
        return _outputs(o.claimId, true, 0, false);
    }

    function _collect(Collect memory c, uint256 positionId) private returns (Output[] memory) {
        bool live = engine.isLive(positionId);
        if (c.keep != live) revert KeepMismatch(live);
        uint256 amount = engine.paidOut(positionId) - _claims[c.claimId].collected;
        _claims[c.claimId].collected += amount;
        emit ClaimCollected(c.claimId, positionId, amount, c.keep);
        return _outputs(c.claimId, c.keep, amount, true);
    }

    // ---------------------------------------------------------------- internals

    /// @dev Exactly one input is the claim (one unit of a known claim); any others are USDG.
    function _claimInputs(Input[] calldata inputs, uint256 claimId) private view returns (uint256, uint256 usdgIn) {
        bool seen;
        for (uint256 i = 0; i < inputs.length; i++) {
            Input calldata x = inputs[i];
            if (x.token == address(0)) {
                if (seen || x.shareId != claimId || x.amount != CLAIM_UNITS) revert BadInputs();
                seen = true;
            } else if (x.token == address(usdg)) {
                usdgIn += x.amount;
            } else {
                revert BadInputs();
            }
        }
        if (!seen) revert BadInputs();
        if (_claims[claimId].positionId == 0) revert UnknownClaim(claimId);
        return (claimId, usdgIn);
    }

    /// @dev Outputs: the claim note when `keep`, then a USDG output when `withUsdg` (possibly zero).
    function _outputs(uint256 claimId, bool keep, uint256 usdgOut, bool withUsdg)
        private
        returns (Output[] memory outputs)
    {
        outputs = new Output[]((keep ? 1 : 0) + (withUsdg ? 1 : 0));
        uint256 k;
        if (keep) outputs[k++] = Output(address(0), claimId, CLAIM_UNITS);
        if (withUsdg) {
            if (usdgOut != 0) usdg.safeTransfer(pool, usdgOut);
            outputs[k] = Output(address(usdg), 0, usdgOut);
        }
    }
}
