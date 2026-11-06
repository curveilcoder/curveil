// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IReportVerifier} from "../interfaces/IReportVerifier.sol";

/// @title SignedReportVerifier
/// @notice TESTNET ONLY. Robinhood Chain testnet has no oracle network, so Curveil's keeper
///         observes public ETH and BTC prices and signs them as EIP-712 reports. This contract
///         accepts a report signed by any enabled signer. It is a stand-in, not an oracle network:
///         whoever holds a signer key can set prices. It refuses to deploy on mainnet.
/// @dev report = abi.encode(bytes32 feedId, uint256 price, uint64 timestamp, bytes signature),
///      signed over PriceReport(bytes32 feedId,uint256 price,uint64 timestamp) in the domain
///      ("Curveil Price Reports", "1", chainId, this contract).
contract SignedReportVerifier is IReportVerifier, EIP712, Ownable2Step {
    uint256 public constant MAINNET_CHAIN_ID = 4663;
    bytes32 public constant REPORT_TYPEHASH = keccak256("PriceReport(bytes32 feedId,uint256 price,uint64 timestamp)");
    string public constant LABEL = "Curveil test price signer (testnet only)";

    mapping(address signer => bool) public isSigner;

    event SignerSet(address indexed signer, bool enabled);

    error TestnetOnly();
    error UnknownSigner(address signer);
    error OutsideRange(uint256 timestamp, uint64 notBefore, uint64 notAfter);

    constructor(address owner_, address signer) EIP712("Curveil Price Reports", "1") Ownable(owner_) {
        if (block.chainid == MAINNET_CHAIN_ID) revert TestnetOnly();
        _setSigner(signer, true);
    }

    function verifyReport(bytes calldata report) public view returns (bytes32 feedId, uint256 price, uint256 timestamp) {
        uint64 ts;
        bytes memory signature;
        (feedId, price, ts, signature) = abi.decode(report, (bytes32, uint256, uint64, bytes));
        address signer = ECDSA.recover(reportDigest(feedId, price, ts), signature);
        if (!isSigner[signer]) revert UnknownSigner(signer);
        timestamp = ts;
    }

    /// @notice Testnet stand-in: checks the time range only. The test signer signs one price a
    ///         tick, so it cannot prove a report is the first after `notBefore`; that is part of
    ///         the trust in the signer described above.
    function verifyFirstReport(bytes calldata report, uint64 notBefore, uint64 notAfter)
        external
        view
        returns (bytes32 feedId, uint256 price, uint256 timestamp)
    {
        (feedId, price, timestamp) = verifyReport(report);
        if (timestamp < notBefore || timestamp > notAfter) revert OutsideRange(timestamp, notBefore, notAfter);
    }

    function reportDigest(bytes32 feedId, uint256 price, uint64 timestamp) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REPORT_TYPEHASH, feedId, price, timestamp)));
    }

    function setSigner(address signer, bool enabled) external onlyOwner {
        _setSigner(signer, enabled);
    }

    function _setSigner(address signer, bool enabled) private {
        isSigner[signer] = enabled;
        emit SignerSet(signer, enabled);
    }
}
