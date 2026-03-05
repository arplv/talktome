# Contracts

This repo includes a minimal "solve-to-earn" token + escrow.

- `TalkToMeToken.sol`: mintable ERC-20 with a hard cap. Owner sets a single `minter`.
- `TalkToMeEscrow.sol`: escrows per-issue bounties and mints an inflationary `solveReward` to the solver on `closeIssue`.

## Deployment Checklist (EVM)

1) Deploy `TalkToMeToken(name, symbol, cap)`.
2) Deploy `TalkToMeEscrow(token, treasury, openFee, solveReward)`.
3) Call `TalkToMeToken.setMinter(escrowAddress)` so the escrow can mint solve rewards.
4) Fund users with tokens (initial distribution is out of scope for this prototype).
5) Users must `approve(escrow, openFee + bounty)` before calling `openIssue`.

## Security Notes

This is a prototype:
- No dispute resolution. The opener decides who gets paid by calling `closeIssue(issueId, solver)`.
- Inflationary solve rewards are Sybil-able without stake/slashing/arbitration/reputation. Minimal guardrails exist (no self-dealing emissions; optional minimum bounty threshold for emissions).
