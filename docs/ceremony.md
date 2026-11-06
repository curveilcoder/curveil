# Trusted setup ceremony (mainnet vault)

The vault's proofs are Groth16. Groth16 needs a per-circuit setup, and whoever knows all of that setup's randomness could forge proofs and drain the vault. A multi-party ceremony removes that risk: many people each add randomness in turn, and the result is safe as long as **one** of them destroyed theirs. Testnet uses a single-party setup and says so; mainnet must not.

Tool: `pnpm --filter @curveil/circuits ceremony <stage>` (`packages/circuits/scripts/ceremony.mjs`).

## 1. Roles

- **Coordinator** (Curveil). Starts the ceremony, passes the files from one contributor to the next, applies the beacon, publishes everything. The coordinator's own trust is not needed: every step is checkable.
- **Contributors.** At least 5, independent of each other and of Curveil (different organisations, countries, machines). Each one runs one command on their own computer and publishes the hash it prints.
- **Anyone.** Can re-run `verify` from the published files.

## 2. Steps

1. **Freeze the circuits.** The ceremony binds to the compiled circuit (`build/<circuit>/<circuit>.r1cs`). Compile from the audited tag (`audit-2-vault` plus any audit fixes) with `pnpm --filter @curveil/circuits compile`, and record the r1cs hashes. If a circuit changes afterwards, the ceremony starts again.
2. **Pick the phase-1 file.** Use a public Powers of Tau transcript with many contributors, of size 2^16 or larger (each circuit has about 15,000 constraints, so 2^14 is the minimum). The Hermez/PSE "perpetual powers of tau" files linked from the snarkjs README are the usual choice. Download it, and check its sha256 against the hash published by its maintainers, not against a copy.
3. **Start.**
   ```sh
   pnpm --filter @curveil/circuits ceremony init --dir ceremony-mainnet \
     --ptau powersOfTau28_hez_final_16.ptau --ptau-sha256 <published hash> \
     --ptau-source "<URL of the published hash>"
   ```
4. **Contributions, one at a time.** Send the contributor `transcript.json` and the newest key of each circuit (about 19 MB in all). They install the repository at the ceremony tag and run:
   ```sh
   pnpm --filter @curveil/circuits ceremony contribute --dir <the folder> --name "<their public name>"
   ```
   The randomness is generated inside the process and never written down. They send the folder back and publish the two contribution hashes it prints (on X, a gist, or their own site), so nobody, including Curveil, can swap their contribution later. The coordinator runs `verify` before passing the folder on.
5. **Beacon.** Announce in advance a future Ethereum mainnet block number. When it is mined, apply its hash:
   ```sh
   pnpm --filter @curveil/circuits ceremony beacon --dir ceremony-mainnet --hash <block hash> \
     --source "Ethereum block <n> hash, announced <date> at <link>" --min 5
   ```
   Nobody can know a future block hash, so nobody can steer the final key.
6. **Verify and finalize.**
   ```sh
   pnpm --filter @curveil/circuits ceremony finalize --dir ceremony-mainnet --network mainnet \
     --verifiers packages/contracts/src/vault/verifiers
   ```
   This verifies the whole chain again, then writes `artifacts/mainnet/` (keys, verification keys, wasm, `setup.json`, `transcript.json`) and regenerates the two Solidity verifiers with the ceremony's label.
7. **Publish.** The phase-1 file's link and hash, every intermediate key, `transcript.json`, every contributor's published hashes, and the beacon announcement. Anyone can then run `verify`.
8. **Deploy.** The new verifiers ship in a new ShieldedPool (verifiers are immutable). The deployment manifest pins the sha256 of each wasm, zkey and verification key, and the app refuses to prove with anything else.

## 3. What `verify` checks

- The phase-1 file is unchanged.
- The compiled circuits are the ones the ceremony started with.
- The newest key of each circuit matches the transcript byte for byte.
- snarkjs re-derives the key from the circuit and the phase-1 file and confirms every contribution in the chain is valid.
- Every contribution hash snarkjs recomputes from the key equals the hash the contributor published, at the same position.

A contribution added after the beacon is refused. Changing any key, or any hash in the transcript, makes `verify` fail.

## 4. Rehearsal (4 November 2026)

Run against the testnet phase-1 file, with three rehearsal contributors and the hash of Robinhood testnet block 148,144,306 as the beacon.

| | Result |
| --- | --- |
| Time | about 25 seconds per contribution on a 4-core machine |
| `verify` | both circuits valid, 4 contributions each including the beacon, transcript matches |
| Changed one contribution hash in the transcript | `verify` reports the mismatch and fails |
| Appended a byte to the final key | refused: the key does not match the transcript |
| Contribution after the beacon | refused |
| Proofs made with the rehearsal keys | `vault-core` circuit tests: 11 of 11 pass (`CIRCUIT_ARTIFACTS=<rehearsal output>`) |

## 5. Open inputs

- The names of at least 5 contributors who agree to take part.
- The date of the ceremony and of the beacon block announcement.

## Mainnet record (4 November 2026)

The first mainnet setup was a two-party setup, run before the vault's audit at the owner's request, with low per-deposit caps until a public ceremony replaces it:

- Phase 1: PSE perpetual powers of tau, contribution 0080, 2^16 file `ppot_0080_16.ptau` (sha256 `ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9`, computed on download).
- Contribution 1: Claude (Curveil coordinator), in the coordinator's sandbox.
- Contribution 2: Raisa (Curveil), in her browser on the site's `/ceremony` page, imported with `ceremony import`.
- Beacon: Ethereum block 26,340,800 (announced in the project about 15 minutes before it was mined), hash `0x5f6a7f23feb9f398df09971d36761ee8d84fe0c30de985c2752bc7254fbdb05b`, 10 iterations.
- Result: `packages/circuits/artifacts/mainnet/` (`setup.json`, `transcript.json`). The deployed verifiers' sources are in `packages/contracts/deployments/mainnet-verifiers/`.

Anyone can re-run `verify` from the published keys. Both contributors are Curveil, so depositors are trusting Curveil until the public ceremony; a new ceremony means new verifiers and a new pool (verifiers are immutable).
