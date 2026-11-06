# Curveil vault specification

Status: testnet, pool version 2 (shielded execution, section 5.4). Circuits `transfer/v1` and
`withdraw/v1`, unchanged from version 1. Unaudited.

This document fixes the vault construction. The circuits (`packages/circuits`), the contract
(`packages/contracts/src/vault/ShieldedPool.sol`), the client library
(`packages/vault-core`) and the services (`apps/api`, `apps/broadcaster`) implement it.
Changing any rule here means changing all of them together, and a circuit change ships as a
new pool.

All hashes inside the field are Poseidon over BN254 (circomlib parameters). `p` is the BN254
scalar field order. `keccak` is Keccak-256. `labelToField(s) = keccak(utf8(s)) mod p`.

## 1. What the vault hides and what it does not

Public on-chain: every deposit (depositor, asset, amount, time); every withdrawal (recipient,
asset, amount, time); that a transfer happened and when; the sender address of every
transaction (the user's wallet when self-submitting, otherwise the broadcaster); broadcaster
fees and their asset.

Private: which note belongs to which account, transfer amounts and recipients, which notes a
transfer or withdrawal spent, and every account's balance.

Shielded execution (section 5.4) runs a public market action from notes. The action itself is
public: the adapter, the route or market, the amounts in and out, the liquidity position and
its holder contract, and any public payout. What stays private is which account paid, which
notes it spent, who holds the resulting notes or position shares, and later private transfers
of those shares.

A broadcaster sees the user's network address and the timing of requests. It cannot change
recipients, amounts or fees, because the proof binds them (section 5).

## 2. Account keys

### 2.1 Recovery phrase

A vault account is 32 bytes of entropy from the browser's CSPRNG, shown to the user as a
24-word BIP-39 English phrase. The phrase is independent of any wallet. Input is trimmed,
lower-cased and split on whitespace; exactly 24 words with a valid checksum are accepted.

### 2.2 Derivation

    spendingKey    = HKDF-SHA256(ikm = entropy, salt = "curveil/vault", info = "spend/v1", 64 bytes) mod p
    viewingPrivate = HKDF-SHA256(ikm = entropy, salt = "curveil/vault", info = "view/v1", 32 bytes)   (X25519)
    viewingPublic  = X25519(viewingPrivate)
    ownerKey       = Poseidon1(spendingKey)

`spendingKey` never leaves the client. `ownerKey` and `viewingPublic` together form the
address.

### 2.3 Shielded address

bech32m with human-readable part `cvl`, payload `0x01 || ownerKey (32 bytes, big-endian) ||
viewingPublic (32 bytes)`, length limit 200. The leading byte is the address version.

## 3. Notes and the tree

### 3.1 Notes

    resource   = keccak(abi.encode(keccak("curveil.resource.fungible.v1"), token)) mod p
    noteDomain = keccak(abi.encode(keccak("curveil.note.v1"), chainId, pool)) mod p
    ownerHash  = Poseidon2(ownerKey, blinding)
    commitment = Poseidon4(resource, amount, ownerHash, noteDomain)
    nullifier  = Poseidon3(spendingKey, commitment, leafIndex)

`amount` is at most 2^128 − 1. `blinding` is 64 random bytes reduced mod p. The note domain
binds every note to one chain and one pool, so a note or proof cannot be replayed elsewhere.
Including `leafIndex` in the nullifier keeps two identical commitments independently
spendable.

### 3.2 Tree

An append-only binary Merkle tree of depth 24 (16,777,216 leaves). Parent =
Poseidon2(left, right). Empty leaves hold `ZERO_LEAF = labelToField("curveil.vault.zero")`;
`zeros[i]` are the empty subtree roots, hardcoded in the contract and recomputed by the
client. The contract keeps the last 100 roots; a proof may use any of them.

## 4. Note encryption

Every new note is published in `NoteCommitted(leafIndex, commitment, encryptedNote)` so its
owner can find it with the viewing key alone.

    esk, epk  = fresh X25519 key pair per note
    shared    = X25519(esk, recipientViewingPublic)
    key       = HKDF-SHA256(ikm = shared, salt = epk || recipientViewingPublic, info = "curveil/note/v1", 32 bytes)
    plaintext = resource (32) || amount (16) || blinding (32)                        80 bytes
    ciphertext= 0x01 || epk (32) || ChaCha20-Poly1305(key, nonce = 0^12, plaintext, aad = 0x01 || epk)

Total 129 bytes. The key is single-use, so the fixed nonce is safe. The contract and the
broadcaster reject any other length.

Version 2 ("open amount") is for notes whose amount is only known on-chain, the outputs of
an execution (section 5.4). The client seals the same layout with version byte `0x02` and
`amount = 0`; the contract appends the real amount and publishes
`encryptedNote || uint128(amount)`, 145 bytes. A reader accepts a version 2 payload only if
the sealed amount is 0, then takes the amount from the last 16 bytes and checks it by
re-opening the commitment like any other note. A decrypted note is accepted only if it re-opens the
on-chain commitment with the reader's own `ownerKey` (section 6).

## 5. Actions

Every spend uses exactly two input notes and creates output notes; a missing input is a
zero-amount note, which skips the membership check. Inside the circuit: amounts are
range-checked to 128 bits, each input's nullifier is recomputed from the spending key, the
two nullifiers must differ, and `sum(inputs) = sum(outputs) + publicOut`.

The `context` public input is a keccak hash (mod p) of everything the contract checks outside
the circuit. The circuit constrains `context * context`, so the proof is bound to it. Any
change to a recipient, fee, fee recipient, deadline or ciphertext invalidates the proof.

### 5.1 Private transfer (`transfer/v1`)

Public inputs, in order: `root, domain, context, fee, feeResource, nullifier[2],
outCommitment[2]`. Output 0 goes to the recipient, output 1 is change. `publicOut = fee`.
The circuit enforces `fee * (feeResource − resource) = 0`, so the fee is paid in the spent
asset.

    context = keccak(abi.encode(keccak("curveil.vault.transfer.v1"), chainId, pool, feeRecipient,
                                fee, feeResource, deadline, keccak(encryptedNote0), keccak(encryptedNote1))) mod p

The contract requires `feeResource = 0` and `feeRecipient = 0` when `fee = 0`, so a zero-fee
transfer has one canonical form.

### 5.2 Withdrawal (`withdraw/v1`)

Public inputs, in order: `root, domain, context, resource, amount, fee, nullifier[2],
outCommitment` (the change note). `publicOut = amount + fee`.

    context = keccak(abi.encode(keccak("curveil.vault.withdraw.v1"), chainId, pool, token, recipient,
                                feeRecipient, fee, uint256(withdrawFeeBps), deadline, keccak(encryptedChange))) mod p

The contract sends `amount − protocolFee` to `recipient`, where
`protocolFee = ceil(amount * withdrawFeeBps / 10000)`, and `fee` to `feeRecipient`. The fee
rate is part of the context, so a rate change invalidates proofs made under the old rate
instead of charging users a rate they did not see.

### 5.3 Shielding

Shielding needs no proof. The client sends `shield(token, amount, ownerHash,
encryptedNote)`. The contract measures the amount actually received (fee-on-transfer tokens
are rejected), computes the commitment itself with `resource`, the received amount and the
pool's domain, and inserts it. Shielding is public by design.

### 5.4 Shielded execution (pool version 2)

`execute(ExecuteArgs)` spends notes into an approved adapter contract, lets it perform one
market action, and settles everything it returns, in one transaction. If any part fails, the
whole transaction reverts and no note is spent.

    ExecuteArgs = { adapter, params, legs[1..2], outputs[0..4], feeRecipient, deadline }
    Leg         = { proof, root, nullifiers[2], resource, amount, fee, change, encryptedChange }
    OutputSpec  = { ownerHash, recipient, fee, encryptedNote }

Each leg is a `withdraw/v1` proof: it spends up to two notes of one resource, releases
`amount` to the adapter and `fee` to `feeRecipient`, and creates a change note. Its context
is the execute context, which commits to the whole action:

    legHash    = keccak(abi.encode(root, resource, amount, fee, nullifier0, nullifier1, change, keccak(encryptedChange)))
    outputHash = keccak(abi.encode(ownerHash, recipient, fee, keccak(encryptedNote)))
    context    = keccak(abi.encode(keccak("curveil.vault.execute.v1"), chainId, pool, adapter, keccak(params),
                                   keccak(legHash0 || legHash1), keccak(outputHash0 || …), feeRecipient,
                                   uint256(withdrawFeeBps), deadline)) mod p

So no leg, output, fee, route, minimum or deadline can be changed, dropped or reused without
invalidating every proof. Two legs never spend the same note.

The adapter returns one output per `OutputSpec`, in its own fixed order. A fungible output is
already back in the pool when the adapter returns. For each output, `fee` goes to
`feeRecipient`, then either:

- `recipient ≠ 0`: a public payout of the rest, less the withdrawal fee
  (`ceil(net * withdrawFeeBps / 10000)`); `encryptedNote` must be empty;
- `recipient = 0`: a new note `Poseidon4(resource, net, ownerHash, domain)` with a version 2
  ciphertext (section 4). A zero `net` creates no note.

A share output (a liquidity position) is always a note and pays no fee. Its resource is
`keccak(abi.encode(keccak("curveil.resource.share.v1"), adapter, shareId)) mod p`, so shares of
different adapters or positions can never be spent as each other or as a token. A share leg
pays no fee; the fee for an exit is taken from a token output instead. After settling, the
pool checks its balance of every output token still covers what it owes (`shieldedBalance`
plus accrued fees). `feeRecipient` is non-zero exactly when some fee is paid.

Adapters (testnet):

| Adapter | `params` | Legs | Outputs |
|---|---|---|---|
| `ShieldedSwapAdapter` | `abi.encode(Hop[] hops, uint256 minOut)` | the input token | `[tokenOut]` |
| `ShieldedLiquidityAdapter`, DAMM entry | `abi.encode(uint8(1), abi.encode(positionId, market, min0, min1, minLiquidity))` | token0 and/or token1 | `[share, refund0, refund1]` |
| `ShieldedLiquidityAdapter`, DLMM entry | `abi.encode(uint8(2), abi.encode(positionId, market, activeIdExpected, idSlippage, deltaIds, distributionX, distributionY))` | tokenX and/or tokenY | `[share, refundX, refundY]` |
| `ShieldedLiquidityAdapter`, exit | `abi.encode(uint8(3), abi.encode(positionId, min0, min1))` | the position's shares | `[token0, token1]` |

Swaps go through the Curveil router and pay only the pool fee. Each liquidity position is held
by its own minimal holder contract and is worth `10^18` units. An entry pays no fee; tokens the
market does not take come back as notes. An exit of `u` units first claims the position's
fees, then pays out `u / units` of its liquidity, fees and idle balance; the last exit takes
everything. Exits to notes pay no fee; exits to a public address pay the withdrawal fee. The
client picks `positionId` at random; anyone who sees a pending entry could open the same id
first, which only makes that entry revert (no funds at risk), and the client retries with a
new id.

Shares move privately with an ordinary `transfer/v1` proof at zero fee (a broadcaster fee
would have to be paid in shares, so the user submits it). With no fee, nothing about the
resource becomes public.

## 6. Note discovery

The client downloads every `(leafIndex, commitment, encryptedNote)` from leaf 0, tries to
decrypt each with its viewing key, and keeps a note only if `Poseidon4(resource, amount,
Poseidon2(ownerKey, blinding), domain)` equals the published commitment. It rebuilds the
whole tree, checks the root against `getLastRoot` / `isKnownRoot`, and marks notes spent by
matching their nullifiers against `NullifierSpent` events. Share notes are matched to their
position through the pool's `ShareRegistered(resource, adapter, shareId)` events (the
alternative client) or the public position list (`/v1/vault/positions`, the website); either
way the matching happens on the device.

The website reads these from the indexer API (`/v1/vault/commitments`,
`/v1/vault/nullifiers`) but verifies the rebuilt root against the contract, so a wrong or
incomplete indexer cannot make it spend against an unknown tree. The alternative client reads
the same events directly from any RPC (docs/vault-alternative-client.md).

## 7. Storage and backups

The website stores the account in IndexedDB as an envelope: format `curveil-vault-backup`
v1, PBKDF2-SHA256 with 600,000 iterations over the NFKC-normalised passphrase, AES-256-GCM.
The same envelope is the downloadable backup file. The passphrase (at least 10 characters)
protects only this device's copy and backup files; the 24-word phrase is the master backup.
An account cannot be saved until the user re-enters three random words of the phrase, so no
deposit can happen before the backup check.

## 8. Trusted setup

Groth16 needs a per-circuit setup. Testnet uses a single-party setup labelled "Curveil
testnet single-party setup (not for mainnet)": a 2^16 powers-of-tau file (sha256
`83551253fcb53dc273d11663e12f5bab56a077c5d26ce17ec36b45cb5f95a5bf`) and one phase-2
contribution per circuit. Whoever ran it could forge proofs, so it is acceptable only for
testnet. Mainnet needs a public multi-party ceremony on a published phase-1 transcript, with
contribution hashes published and the resulting verifiers deployed as a new pool. The procedure and tool are in [`docs/ceremony.md`](ceremony.md)
(rehearsed on 4 November 2026).

The deployment manifest pins the sha256 of each circuit's wasm, zkey and verification key
(`circuits` in `packages/manifest/manifests/<network>.json`). The website and the alternative
client refuse to prove with files that do not match.

## 9. Contract rules

- Admitted assets only, each with a per-deposit cap (`maxDeposit`, 0 = no cap) and a
  shielding switch. Turning shielding off for an asset never blocks its exits.
- `withdrawFeeBps` is at most 100 (1%). Testnet: 10 (0.10%). Protocol fees accrue per asset
  and anyone can call `claimProtocolFees`, which pays `protocolFeeRecipient`.
- Shielding and private transfers carry no protocol fee. Shielded swaps pay only the pool
  fee; liquidity entries and exits to notes pay none; payouts to a public address pay the
  withdrawal fee.
- Adapters are enabled by the owner as Active or ExitOnly. Once enabled, an adapter can never
  be fully disabled, so positions it issued can always be exited. An ExitOnly adapter takes
  no token legs.
- An action that spends token notes may not create notes of an asset whose shielding is
  switched off; exits always may.
- Pause: the guardian or the owner can pause shielding and spending separately. A shielding
  pause lasts until the owner lifts it. A spending pause also stops withdrawals, so it ends on
  its own after 72 hours (`MAX_SPEND_PAUSE`), cannot be extended, and cannot start again until
  24 hours after it ended (`SPEND_PAUSE_GAP`), even if the owner ended it early. No pause can
  trap funds for good.
- Verifiers are immutable. A circuit change ships as a new pool; the old one keeps honouring
  withdrawals.
- Ownership uses a two-step transfer.

## 10. Services

### 10.1 Indexer API (read-only)

    GET /v1/vault/status                      live pool state, assets, circuit hashes, setup label
    GET /v1/vault/roots                       recent roots
    GET /v1/vault/commitments?fromLeaf=&limit= commitments and ciphertexts, contiguous from fromLeaf (limit ≤ 2000)
    GET /v1/vault/nullifiers?fromBlock=       spent nullifiers (≤ 5000 per page)
    GET /v1/vault/activity?account=           public activity: shields, withdrawals, transfer fees, executions (legs and outputs)
    GET /v1/vault/positions?fromBlock=        every shielded liquidity position, its market, holder and remaining units

### 10.2 Broadcaster

A broadcaster submits proof-bound transactions and pays gas, for a fee taken from the notes.
It keeps no logs.

    GET  /v1/broadcast/info                  address, gas balance, health, fees per asset, disclosure
    POST /v1/broadcast/quote   {action, token}            fee and fee recipient to put in the proof
    POST /v1/broadcast/submit  {action, proof, args}      validates, simulates, signs, sends
                               {action: "execute", args}  the same for an execution (proofs inside each leg)
    GET  /v1/broadcast/:id                   submitted | confirmed | failed | dropped

It accepts only proofs whose `feeRecipient` is its own address and whose fee meets its
quote, with at least 60 seconds left before the deadline. An execution costs more gas, so its
fee is the asset's base fee times `feeMultipliers.execute` (3 on testnet); the fee may sit on
a leg or on a token output. It relays only to the adapters it lists in `/v1/broadcast/info`. Nullifiers already in flight are
refused. Users can always submit from their own wallet instead.

## 11. Before mainnet

1. Independent audit of the circuits, contract and client library.
2. Public multi-party trusted setup (section 8) and a new pool with the resulting verifiers.
3. ~~Decide whether a spending pause should expire automatically.~~ Done: it ends after 72
   hours and cannot be chained (section 9).
4. A second, independently operated broadcaster.
5. Audit of each adapter: an adapter is trusted with the tokens sent to it and with the
   positions it issues. New adapters ship ExitOnly-capable from day one.
6. Licensing: circomlib circuits and the snarkjs verifier template are GPL-3.0. The circuits
   package is marked GPL-3.0-only and the generated verifiers carry the GPL header; the rest
   of the contracts are UNLICENSED. This needs a legal decision before mainnet.
