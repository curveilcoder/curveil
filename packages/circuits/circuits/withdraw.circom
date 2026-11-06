pragma circom 2.1.9;

// Curveil vault withdrawal, public-input schema "withdraw/v1" (docs/vault-spec.md 5.2).
// Spends up to two notes, releases `amount` of the resource to a public recipient, pays a
// broadcaster `fee`, and returns the rest as one change note.

include "lib/vault.circom";

template Withdraw(levels) {
    // Public inputs, in schema order.
    signal input root;
    signal input domain;
    signal input context;
    signal input resource;
    signal input amount;
    signal input fee;
    signal input nullifier[2];
    signal input outCommitment;

    // Private inputs.
    signal input spendingKey;
    signal input inAmount[2];
    signal input inBlinding[2];
    signal input inLeafIndex[2];
    signal input inPath[2][levels];
    signal input outAmount;
    signal input outOwnerKey;
    signal input outBlinding;

    signal contextSquare <== context * context;

    component amountRange = Num2Bits(128);
    amountRange.in <== amount;
    component feeRange = Num2Bits(128);
    feeRange.in <== fee;

    component core = SpendCore(2, 1, levels);
    core.root <== root;
    core.domain <== domain;
    core.resource <== resource;
    core.publicOut <== amount + fee;
    core.spendingKey <== spendingKey;
    for (var i = 0; i < 2; i++) {
        core.nullifier[i] <== nullifier[i];
        core.inAmount[i] <== inAmount[i];
        core.inBlinding[i] <== inBlinding[i];
        core.inLeafIndex[i] <== inLeafIndex[i];
        for (var l = 0; l < levels; l++) {
            core.inPath[i][l] <== inPath[i][l];
        }
    }
    core.outCommitment[0] <== outCommitment;
    core.outAmount[0] <== outAmount;
    core.outOwnerKey[0] <== outOwnerKey;
    core.outBlinding[0] <== outBlinding;
}

component main {public [root, domain, context, resource, amount, fee, nullifier, outCommitment]} = Withdraw(24);
