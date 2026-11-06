pragma circom 2.1.9;

// Shared templates for the Curveil vault circuits.
// The construction is fixed in docs/vault-spec.md; change both together.

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

// Note commitment (spec section 3):
//   commitment = Poseidon4(resource, amount, Poseidon2(ownerKey, blinding), domain)
// The inner hash lets the vault build a deposit commitment on-chain from the amount it
// actually received without learning the owner key.
template NoteCommitment() {
    signal input resource;
    signal input amount;
    signal input ownerKey;
    signal input blinding;
    signal input domain;
    signal output out;

    component owner = Poseidon(2);
    owner.inputs[0] <== ownerKey;
    owner.inputs[1] <== blinding;

    component c = Poseidon(4);
    c.inputs[0] <== resource;
    c.inputs[1] <== amount;
    c.inputs[2] <== owner.out;
    c.inputs[3] <== domain;
    out <== c.out;
}

// Root of a binary Poseidon Merkle tree, walking up from `leaf` at position `leafIndex`.
// Num2Bits also bounds leafIndex below 2^levels.
template MerkleRoot(levels) {
    signal input leaf;
    signal input leafIndex;
    signal input pathElements[levels];
    signal output root;

    component bits = Num2Bits(levels);
    bits.in <== leafIndex;

    component hashers[levels];
    signal node[levels + 1];
    signal left[levels];
    signal right[levels];
    node[0] <== leaf;
    for (var i = 0; i < levels; i++) {
        // bit = 0: the current node is the left child.
        left[i] <== node[i] + bits.out[i] * (pathElements[i] - node[i]);
        right[i] <== node[i] + pathElements[i] - left[i];
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];
        node[i + 1] <== hashers[i].out;
    }
    root <== node[levels];
}

// Spends nIns notes of one resource owned by one spending key and creates nOuts notes of
// the same resource. Enforces ownership, membership of every non-zero input, nullifier
// derivation, distinct nullifiers, output commitments, 128-bit amounts, and
//   sum(inputs) == sum(outputs) + publicOut
// where publicOut is the value that leaves the note set in this action.
template SpendCore(nIns, nOuts, levels) {
    signal input root;
    signal input domain;
    signal input resource;
    signal input publicOut;
    signal input nullifier[nIns];
    signal input outCommitment[nOuts];

    signal input spendingKey;
    signal input inAmount[nIns];
    signal input inBlinding[nIns];
    signal input inLeafIndex[nIns];
    signal input inPath[nIns][levels];

    signal input outAmount[nOuts];
    signal input outOwnerKey[nOuts];
    signal input outBlinding[nOuts];

    // Owner key = Poseidon1(spending key). Only the spending key holder can open inputs.
    component ownerKey = Poseidon(1);
    ownerKey.inputs[0] <== spendingKey;

    component inRange[nIns];
    component inNote[nIns];
    component inNullifier[nIns];
    component inTree[nIns];
    component inRootCheck[nIns];
    var sumIn = 0;
    for (var i = 0; i < nIns; i++) {
        inRange[i] = Num2Bits(128);
        inRange[i].in <== inAmount[i];

        inNote[i] = NoteCommitment();
        inNote[i].resource <== resource;
        inNote[i].amount <== inAmount[i];
        inNote[i].ownerKey <== ownerKey.out;
        inNote[i].blinding <== inBlinding[i];
        inNote[i].domain <== domain;

        // nullifier = Poseidon3(spendingKey, commitment, leafIndex)
        inNullifier[i] = Poseidon(3);
        inNullifier[i].inputs[0] <== spendingKey;
        inNullifier[i].inputs[1] <== inNote[i].out;
        inNullifier[i].inputs[2] <== inLeafIndex[i];
        inNullifier[i].out === nullifier[i];

        inTree[i] = MerkleRoot(levels);
        inTree[i].leaf <== inNote[i].out;
        inTree[i].leafIndex <== inLeafIndex[i];
        for (var l = 0; l < levels; l++) {
            inTree[i].pathElements[l] <== inPath[i][l];
        }

        // A zero-value input is a padding note and needs no membership proof.
        inRootCheck[i] = ForceEqualIfEnabled();
        inRootCheck[i].enabled <== inAmount[i];
        inRootCheck[i].in[0] <== root;
        inRootCheck[i].in[1] <== inTree[i].root;

        sumIn += inAmount[i];
    }

    // The same note cannot be spent twice in one action.
    component sameNullifier[nIns * (nIns - 1) / 2];
    var k = 0;
    for (var i = 0; i < nIns - 1; i++) {
        for (var j = i + 1; j < nIns; j++) {
            sameNullifier[k] = IsEqual();
            sameNullifier[k].in[0] <== nullifier[i];
            sameNullifier[k].in[1] <== nullifier[j];
            sameNullifier[k].out === 0;
            k++;
        }
    }

    component outRange[nOuts];
    component outNote[nOuts];
    var sumOut = 0;
    for (var j = 0; j < nOuts; j++) {
        outRange[j] = Num2Bits(128);
        outRange[j].in <== outAmount[j];

        outNote[j] = NoteCommitment();
        outNote[j].resource <== resource;
        outNote[j].amount <== outAmount[j];
        outNote[j].ownerKey <== outOwnerKey[j];
        outNote[j].blinding <== outBlinding[j];
        outNote[j].domain <== domain;
        outNote[j].out === outCommitment[j];

        sumOut += outAmount[j];
    }

    sumIn === sumOut + publicOut;
}
