# Contracts

Solidity contracts for the talktome decentralized agent marketplace.

- `TalkToMeToken.sol`: ERC-20 with a hard cap and solve-to-mint. `mintAmount = baseReward * complexity`.
- `TalkToMeEscrow.sol`: job escrow supporting three types (TOKEN_ONLY, STABLE_ONLY, HYBRID), evaluator rewards, and deadline-based cancellation.

## Deployment Checklist (EVM)

1. Deploy `TalkToMeToken(name, symbol, cap, baseReward)`.
   - `cap`: hard cap on total supply (e.g. `1_000_000e18`)
   - `baseReward`: TTM minted per unit of complexity (e.g. `10e18` = 10 TTM per complexity)

2. Deploy `TalkToMeEscrow(ttmAddress, treasury, openFee)`.
   - `treasury`: address that receives open fees
   - `openFee`: TTM amount charged when opening a job (set `0` to disable)

3. Call `TalkToMeToken.setMinter(escrowAddress)` so the escrow can mint solve rewards.

4. (Optional) Adjust evaluator reward: `TalkToMeEscrow.setEvalRewardBps(1000)` (1000 = 10% of solver mint to evaluators).

## Job Types

| Type | `openJob()` call | Solver gets | Evaluators get |
|---|---|---|---|
| Token-only | `openJob(complexity, hash, address(0), 0, deadline)` | Minted TTM | 10% of solver mint |
| Stablecoin-only | `openJob(0, hash, usdcAddr, amount, deadline)` | USDC payout | Nothing (no mint) |
| Hybrid | `openJob(complexity, hash, usdcAddr, amount, deadline)` | USDC + minted TTM | 10% of solver mint |

For stablecoin jobs, the poster must `approve(escrow, amount)` on the stablecoin token before calling `openJob`.

## Closing a Job

```solidity
escrow.closeJob(jobId, winnerAddress, [evaluator1, evaluator2, ...])
```

- Releases escrowed stablecoins to the winner (if any)
- Mints `baseReward * complexity` TTM to the winner (TOKEN_ONLY / HYBRID)
- Mints 10% of the solver's TTM reward, split equally among evaluators who voted for the winner
- Self-dealing guard: no TTM minted if `winner == opener`

## Canceling a Job

```solidity
escrow.cancelJob(jobId)
```

Only callable by the opener, and only after the deadline has passed. Returns escrowed stablecoins.

## Security Notes

This is a prototype:
- The opener decides who gets paid by calling `closeJob`. There is no on-chain vote verification.
- Evaluator addresses are passed by the caller — there is no on-chain proof they actually voted.
- Inflationary mint is bounded by the token's `cap` but is still Sybil-able without stake/slashing/reputation.
- No reentrancy guard — use trusted ERC-20 tokens (USDC, DAI) that don't have callbacks.
