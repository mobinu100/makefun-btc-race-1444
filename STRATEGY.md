# CBBTC Trend + Dip Bot — make.fun btc-race-24h-20261118-1444

A bot that trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute,
on the replay's 1-minute bars. Long only, $1,000 paper start, one position at
a time, half of cash per entry.

## Strategy

Two legs, chosen from the dev window's own structure (1,440 1-minute bars,
BTC -2.8% on the day):

- **Leg A — 60-minute momentum.** A past 60-minute return in the top decile
  (+69 bps) is followed by +29 bps over the next 60 minutes and +31 bps over
  120 minutes on this window. Enter when the 60-minute return exceeds
  +55 bps; exit on a 90 bps trailing stop from the peak close or after
  150 bars.
- **Leg B — deep dip.** A 120-minute-scale drop of about -129 bps is followed
  by +51 bps over the next 4 hours. Enter when the close sits 120 bps or
  more below the 30-bar SMA; exit at +120 bps from the entry close, at
  -60 bps, or after 120 bars.

Shared controls: 15-bar cooldown after any exit, no new entries in the last
60 bars, `max_slippage_bps` 100 (typical fill moves ~8 bps, so rejections
should not happen). A full-size round trip costs ~36 bps here (4 bps fee +
2 bps slippage each way, ~12 bps of price impact per side at the dev
window's ~$844k median pool depth), which is why entries are half-size and
only on strong signals. Short-horizon (15-minute) mean reversion was tested
and rejected: its +17 bps average bounce is smaller than the round-trip
cost.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, `vendor/makefun-bars.ts`
  shim for the `agent-fun/bars-replay/v1` wire protocol).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's SDK shim.
- `.makefun/owner.json` — claim file naming the entry wallet.

## Local grade (dev window)

```
net PnL   +8.25 USDC (8 trades, win rate 0.50, max drawdown 0.52%)
fees      ~$1.61; at 2x fees net PnL still positive
guardrails met
```

All five kit baselines lose on this window (buy-and-hold -$31.63, momentum
-$23.87, ema-cross -$148.17, rsi-bollinger -$39.92, adx-momentum -$75.57).
The dev window's extractable alpha is small (a perfect-foresight oracle
makes ~+$39), so the margin above the dev gate is modest by construction;
the race window is a different 24 hours and decides the prizes.

## Run locally

From the unpacked kit:

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```
