pragma circom 2.1.9;

// Curveil vault private transfer, public-input schema "transfer/v1" (docs/vault-spec.md 5.1).
// Spends up to two notes and creates two notes (recipient and change) of the same resource.
// A broadcaster fee, when present, leaves the note set publicly and is paid in that resource.

include "lib/vault.circom";

template Transfer(levels) {
    // Public inputs, in schema order.
    signal input root;
    signal input domain;
    signal input context;
    signal input fee;
    signal input feeResource;
    signal input nullifier[2];
    signal input outCommitment[2];

    // Private inputs.
    signal input resource;
    signal input spendingKey;
    signal input inAmount[2];
    signal input inBlinding[2];
    signal input inLeafIndex[2];
    signal input inPath[2][levels];
    signal input outAmount[2];
    signal input outOwnerKey[2];
    signal input outBlinding[2];

    // The context hash binds chain, contract, recipients, deadline and ciphertexts.
    signal contextSquare <== context * context;

    component feeRange = Num2Bits(128);
    feeRange.in <== fee;
    // A non-zero fee is paid in the spent resource. With no fee, feeResource stays 0
    // so the transfer does not reveal which asset moved.
    fee * (feeResource - resource) === 0;

    component core = SpendCore(2, 2, levels);
    core.root <== root;
    core.domain <== domain;
    core.resource <== resource;
    core.publicOut <== fee;
    core.spendingKey <== spendingKey;
    for (var i = 0; i < 2; i++) {
        core.nullifier[i] <== nullifier[i];
        core.inAmount[i] <== inAmount[i];
        core.inBlinding[i] <== inBlinding[i];
        core.inLeafIndex[i] <== inLeafIndex[i];
        for (var l = 0; l < levels; l++) {
            core.inPath[i][l] <== inPath[i][l];
        }
        core.outCommitment[i] <== outCommitment[i];
        core.outAmount[i] <== outAmount[i];
        core.outOwnerKey[i] <== outOwnerKey[i];
        core.outBlinding[i] <== outBlinding[i];
    }
}

component main {public [root, domain, context, fee, feeResource, nullifier, outCommitment]} = Transfer(24);
