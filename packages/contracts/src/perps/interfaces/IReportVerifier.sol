// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @notice Checks a signed price report from the oracle network and returns what it says.
///         The OracleAdapter calls it for every price perps use. Implementations: the testnet
///         SignedReportVerifier (Curveil's labelled test signer) and PythReportVerifier.
/// @dev Not `view`: a verifier may pay a verification fee or record usage.
interface IReportVerifier {
    /// @notice Any valid report. Used for liquidations, conditional orders and price records,
    ///         where the OracleAdapter's freshness rules are enough.
    /// @return feedId    Which price this is (the OracleAdapter maps feeds to markets).
    /// @return price     USD per one whole unit of the asset, with 18 decimals.
    /// @return timestamp When the oracle observed the price (seconds).
    function verifyReport(bytes calldata report) external returns (bytes32 feedId, uint256 price, uint256 timestamp);

    /// @notice The first report for its feed observed at or after `notBefore`, and no later than
    ///         `notAfter`. Used to fill open and close requests, so that whoever executes a
    ///         request cannot choose between prices: there is only one that passes.
    /// @dev An oracle network that cannot prove "first" may only check the range; it must say so.
    function verifyFirstReport(bytes calldata report, uint64 notBefore, uint64 notAfter)
        external
        returns (bytes32 feedId, uint256 price, uint256 timestamp);
}
