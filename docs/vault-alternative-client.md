# Using the vault without the Curveil website

If the website, the API or the broadcaster is down, or you prefer not to use them, you can
still see and move your shielded funds. The alternative client in
`packages/vault-core/scripts/vault-cli.ts` needs only:

- your 24-word Curveil recovery phrase,
- a public RPC endpoint for the chain,
- for sending: any wallet with a little ETH for gas.

It does not contact any Curveil service. It reads the pool's own events from the RPC,
rebuilds the note tree, checks the rebuilt root against the contract, finds your notes with
your viewing key, proves locally with the circuit files in this repository (checked against
the hashes in the deployment manifest), and submits from your wallet.

## Setup

Requires Node.js 22 or later and pnpm.

    git clone <this repository>
    cd curveil
    pnpm install

## Commands

The phrase is read from standard input, or from `CURVEIL_PHRASE`. Never pass it as a
command-line argument, because shells keep a history.

    pnpm --filter @curveil/vault-core vault address
    pnpm --filter @curveil/vault-core vault balance
    pnpm --filter @curveil/vault-core vault withdraw tUSDG 25 0xYourPublicAddress
    pnpm --filter @curveil/vault-core vault transfer tUSDG 10 cvl1…
    pnpm --filter @curveil/vault-core vault exit 1 100
    pnpm --filter @curveil/vault-core vault exit 1 50 0xYourPublicAddress

`balance` lists each asset and each unspent note, then each shielded liquidity position you
hold (found from the pool's own `ShareRegistered` events), with your share of it and what it
is worth now including unclaimed fees. A spend uses at most two notes; if you need more, first
send a transfer to your own address to combine two notes.

`exit <position> <percent> [0xrecipient]` exits part or all of a position, named by its number
in `balance` or its full id. Without a recipient the tokens come back to your notes with no
fee; with one they are paid to that public address, less the withdrawal fee. Each payout may
fall at most 1% below the quote printed before proving, or the exit reverts.

## Funds in the previous pool

The website moved to a new pool when shielded swaps and liquidity arrived. The previous pool
keeps honouring withdrawals and transfers. Set `POOL=legacy` to use it:

    POOL=legacy pnpm --filter @curveil/vault-core vault balance
    POOL=legacy pnpm --filter @curveil/vault-core vault withdraw tUSDG 0.2 0xYourPublicAddress

## Sending

Without a wallet key, `withdraw` and `transfer` print the pool address, chain id and
calldata. Paste them into any wallet that can send raw calldata, and send within 20 minutes
(the proof's deadline).

To send directly, set `WALLET_PRIVATE_KEY` for that run only. That wallet's address becomes
public as the sender, and it pays gas. There is no broadcaster fee. The 0.10% withdrawal fee
still applies, and the client prints what the recipient will receive before proving.

## Options

| Variable             | Default                           | Meaning                                        |
| -------------------- | --------------------------------- | ---------------------------------------------- |
| `NETWORK`            | `testnet`                         | Which bundled deployment manifest to use       |
| `RPC_URL`            | the manifest's public RPC         | Any RPC endpoint for that chain                |
| `POOL`               | the current pool                  | `legacy` for the previous pool, or a pool address from the manifest |
| `CURVEIL_PHRASE`     | read from standard input          | Your recovery phrase                           |
| `WALLET_PRIVATE_KEY` | unset (print calldata instead)    | Wallet that sends the transaction and pays gas |

If the client says the rebuilt root is unknown to the contract, the RPC is behind or returned
incomplete logs. Try again, or use another RPC.

## Tested

On Robinhood Chain testnet (2 November 2026), with an account created on the website: the
client derived the same address, found the same balance from raw events, withdrew 0.5 tUSDG
(the recipient received exactly 0.4995 after the fee) and sent a private transfer that the
recipient's website account then showed. Proving took about 2.5 seconds per action.

Shielded execution (same day): `balance` listed a DAMM and a DLMM position opened on the
website, with values matching the site; `exit 2 100` closed the DLMM position back to notes in
one transaction (proof 2.8 seconds); and `POOL=legacy` found and withdrew a note left in the
previous pool.

The construction it follows is in docs/vault-spec.md.
