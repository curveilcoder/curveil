// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @notice Interface of the snarkjs-generated Groth16 verifiers with nine public inputs
///         (transfer/v1 and withdraw/v1).
interface IGroth16Verifier9 {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[9] calldata pubSignals
    ) external view returns (bool);
}
