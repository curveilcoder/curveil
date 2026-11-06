/**
 * ShieldedPerpsAdapter parameters. The vectors below are also checked against Solidity's
 * abi.encode in packages/contracts/test/perps/PerpsParams.t.sol, so the client and the adapter
 * read the same bytes.
 */
import { describe, expect, it } from "vitest";
import {
  ORDER_STOP_LOSS,
  PERP_OP_CLOSE,
  PERP_OP_COLLECT,
  PERP_OP_OPEN,
  PERP_OP_PLACE_ORDER,
  decodePerpsParams,
  encodePerpAddCollateral,
  encodePerpCancelOrder,
  encodePerpClose,
  encodePerpCollect,
  encodePerpOpen,
  encodePerpPlaceOrder,
  newClaimId,
  perpsOutputKinds,
} from "../src";

export const OPEN = { claimId: 0xc1a1n, market: 1, isLong: true, size: 10_000_000_000n, collateral: 2_100_000_000n, acceptablePrice: 2_010n * 10n ** 18n, executionFee: 200_000n };

describe("perps adapter params", () => {
  it("round-trips every op", () => {
    const open = encodePerpOpen(OPEN);
    expect(decodePerpsParams(open)).toEqual({ op: PERP_OP_OPEN, open: OPEN });
    const close = { claimId: 5n, size: 1n, acceptablePrice: 0n, executionFee: 200_000n };
    expect(decodePerpsParams(encodePerpClose(close))).toEqual({ op: PERP_OP_CLOSE, close });
    const order = { claimId: 5n, kind: ORDER_STOP_LOSS, triggerPrice: 1_900n * 10n ** 18n, size: 0n, acceptablePrice: 0n, executionFee: 200_000n, expiresAt: 0n };
    expect(decodePerpsParams(encodePerpPlaceOrder(order))).toEqual({ op: PERP_OP_PLACE_ORDER, order });
    expect(decodePerpsParams(encodePerpCollect(5n, false))).toEqual({ op: PERP_OP_COLLECT, claimId: 5n, keep: false });
    expect(decodePerpsParams(encodePerpCancelOrder(5n, 9n))).toMatchObject({ claimId: 5n, orderId: 9n });
    expect(decodePerpsParams(encodePerpAddCollateral(5n))).toMatchObject({ claimId: 5n });
  });

  it("matches the Solidity vector", () => {
    expect(encodePerpOpen(OPEN)).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000c1a10000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000002540be400000000000000000000000000000000000000000000000000000000007d2b750000000000000000000000000000000000000000000000006cf65a7e90472800000000000000000000000000000000000000000000000000000000000000030d40",
    );
  });

  it("lists outputs in adapter order", () => {
    const collect = decodePerpsParams(encodePerpCollect(1n, true));
    expect(perpsOutputKinds(collect, false)).toEqual(["claim", "usdg"]);
    expect(perpsOutputKinds(decodePerpsParams(encodePerpCollect(1n, false)), false)).toEqual(["usdg"]);
    expect(perpsOutputKinds(decodePerpsParams(encodePerpOpen(OPEN)), false)).toEqual(["claim"]);
    const close = decodePerpsParams(encodePerpClose({ claimId: 1n, size: 1n, acceptablePrice: 0n, executionFee: 1n }));
    expect(perpsOutputKinds(close, true)).toEqual(["claim", "usdg"]);
    expect(perpsOutputKinds(close, false)).toEqual(["claim"]);
  });

  it("makes non-zero claim ids", () => {
    expect(newClaimId()).not.toBe(0n);
  });
});
