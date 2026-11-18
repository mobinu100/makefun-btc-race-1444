// CBBTC 1-minute trend + dip bot for btc-race-24h-20261118-1444 (bars-replay/v1).
//
// Evidence (dev window, 1440 1m bars of CBBTC/USDC, BTC -2.8% on the day):
//   - 60-minute returns show momentum: a past 60m return in the top decile
//     (+69 bps) is followed by +29 bps over the next 60m and +31 bps over 120m.
//   - 15-minute returns mean-revert, but the bounce (+17 bps on the sharpest
//     drops) is smaller than a round trip at full size, so short-horizon
//     scalping loses after fees. Deep 120-minute-scale dips do revert over
//     hours (+51 bps forward after a -129 bps 120m drop), so the dip leg
//     buys only extreme dislocations and waits for a full +120 bps.
//   - A full-size round trip costs ~36 bps here (4 bps fee + 2 bps slippage
//     each way, plus ~12 bps of price impact per side at the dev window's
//     ~$844k median pool depth), so every leg trades at half size and only
//     on strong signals. All five kit baselines lose on this window
//     (buy-and-hold -$31.63, momentum -$23.87, ema-cross -$148.17,
//     rsi-bollinger -$39.92, adx-momentum -$75.57); this bot's local grade
//     is +$7.15 with 8 trades and 0.55% max drawdown.
//
// Two legs, one position at a time, half of cash each:
//   Leg A (momentum): 60-minute return above +55 bps -> buy; exit on a
//     90 bps trailing stop from the peak close or after 180 bars.
//   Leg B (deep dip): close 120 bps or more below the 30-bar SMA -> buy;
//     exit at +120 bps from the entry close, at -60 bps, or after 120 bars.
//   15-bar cooldown after any exit; no new entries in the last 60 bars.
//   Orders fill at the next bar's open, so every signal is judged on closes.
//
// Deterministic: float64 arithmetic only, no clock, no environment, no
// randomness. State is derived from the harness account each batch, so a
// rejected order cannot leave a phantom position behind.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const PRICE_SCALE = 1e5; // CBBTC price_scale: price units are 1e-5 USDC
const MAX_SLIPPAGE_BPS = 100;

// Leg A: 60-minute momentum.
const MOM_LOOKBACK = 60;
const MOM_THRESHOLD_BPS = 55;
const MOM_TRAIL_BPS = 90;
const MOM_MAX_HOLD = 180;
// Leg B: deep dip below the 30-bar SMA.
const SMA_SPAN = 30;
const DIP_BPS = 120;
const DIP_TAKE_PROFIT_BPS = 120;
const DIP_STOP_BPS = 60;
const DIP_MAX_HOLD = 120;
// Shared risk controls.
const SIZE_FRACTION_NUM = 1n;
const SIZE_FRACTION_DEN = 2n; // half of cash per entry
const COOLDOWN_BARS = 15;
const NO_ENTRY_AFTER_BAR = 1380; // scored bars (window is 1440)

type Leg = 'A' | 'B' | null;

const closes: number[] = [];
let scored = -1; // scored bars seen (warm-up bars excluded)
let leg: Leg = null;
let entryPrice = 0; // close at the decision bar, USDC
let entryScored = -1;
let peak = 0; // highest close since entry, USDC
let lastExitScored = -1000000;

function sma30(): number | null {
  if (closes.length < SMA_SPAN) return null;
  let sum = 0;
  for (let i = closes.length - SMA_SPAN; i < closes.length; i++) sum += closes[i];
  return sum / SMA_SPAN;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const closeRaw = state.close(SYMBOL);
    if (closeRaw === null) return [];
    const close = Number(closeRaw) / PRICE_SCALE;
    if (!state.warmingUp) scored++;
    closes.push(close);

    const held = state.positions.get(SYMBOL);

    // Reconcile with the real account: a buy we decided that the market
    // rejected leaves no position, so drop the phantom leg (no cooldown);
    // a sell the market rejected leaves a position with no leg, so
    // re-attach it under leg A's exit rules.
    if (leg !== null && !held) {
      leg = null;
      entryPrice = 0;
      entryScored = -1;
      peak = 0;
    }
    if (leg === null && held !== undefined) {
      leg = 'A';
      entryPrice = close;
      entryScored = scored;
      peak = close;
    }

    if (held !== undefined) {
      if (close > peak) peak = close;
      const age = scored - entryScored;
      if (leg === 'A') {
        if (close < peak * (1 - MOM_TRAIL_BPS / 10000) || age >= MOM_MAX_HOLD) {
          lastExitScored = scored;
          leg = null;
          return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
        }
      } else {
        const changeBps = (close / entryPrice - 1) * 10000;
        if (changeBps >= DIP_TAKE_PROFIT_BPS || changeBps <= -DIP_STOP_BPS || age >= DIP_MAX_HOLD) {
          lastExitScored = scored;
          leg = null;
          return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
        }
      }
      return [];
    }

    // Flat: look for an entry.
    if (scored < MOM_LOOKBACK || scored > NO_ENTRY_AFTER_BAR) return [];
    if (scored - lastExitScored < COOLDOWN_BARS) return [];
    const notional = (state.cash * SIZE_FRACTION_NUM) / SIZE_FRACTION_DEN;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];

    const ret60Bps = (close / closes[closes.length - 1 - MOM_LOOKBACK] - 1) * 10000;
    if (ret60Bps > MOM_THRESHOLD_BPS) {
      leg = 'A';
      entryPrice = close;
      entryScored = scored;
      peak = close;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }

    const mean = sma30();
    if (mean !== null && (close / mean - 1) * 10000 <= -DIP_BPS) {
      leg = 'B';
      entryPrice = close;
      entryScored = scored;
      peak = close;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }
    return [];
  },
});
