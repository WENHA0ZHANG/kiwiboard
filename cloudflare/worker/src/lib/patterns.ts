import type { YahooBar } from "./yahoo";
import { ema, mean, quadFit, r2, slope } from "./indicators";

// ── Momentum-breakout bases (heuristic) ──────────────────────────────────────
// Every pattern here is a variation on one idea: after an advance, price
// builds a base whose swings get progressively smaller, usually with higher
// lows, ending just under a pivot it can break out of. Thresholds follow the
// commonly cited textbook ranges; no proprietary methodology is reproduced.

export type Timeframe = "daily" | "weekly";
export type PatternKind =
  | "htf" | "bull_flag" | "pennant" | "vcp" | "cup_handle" | "cup" | "asc_triangle" | "inverse_hs";

export interface PatternPoint {
  date: string;
  price: number;
  tag: string; // e.g. "L1", "H2", "rim", "handle"
}

export interface PatternResult {
  kind: PatternKind | null;
  timeframe: Timeframe | null;
  label: string | null;           // human-readable, e.g. "Cup & Handle (W)"
  flag_start: string | null;      // base start
  flag_end: string | null;        // last bar
  pole_start: string | null;      // start of the advance into the base
  pivot: number | null;           // breakout trigger
  pole_gain_pct: number | null;   // advance into the base
  flag_depth_pct: number | null;  // deepest pullback inside the base
  flag_bars: number | null;       // base length in bars
  note: string | null;            // short shape summary, e.g. "24% → 11% → 5%"
  points: PatternPoint[];         // swing points that define the shape
}

export const EMPTY_PATTERN: PatternResult = {
  kind: null, timeframe: null, label: null,
  flag_start: null, flag_end: null, pole_start: null, pivot: null,
  pole_gain_pct: null, flag_depth_pct: null, flag_bars: null,
  note: null, points: [],
};

const LABELS: Record<PatternKind, string> = {
  htf: "High Tight Flag",
  bull_flag: "Bull Flag",
  pennant: "Pennant",
  vcp: "VCP",
  cup_handle: "Cup & Handle",
  cup: "Cup (No Handle)",
  asc_triangle: "Ascending Triangle",
  inverse_hs: "Inverse H&S",
};

export const PATTERN_CODES: Record<PatternKind, string> = {
  htf: "HTF",
  bull_flag: "BULL_FLAG",
  pennant: "PENNANT",
  vcp: "VCP",
  cup_handle: "CUP_HANDLE",
  cup: "CUP",
  asc_triangle: "ASC_TRI",
  inverse_hs: "INV_HS",
};

function result(
  kind: PatternKind,
  tf: Timeframe,
  bars: YahooBar[],
  fields: Partial<PatternResult> & { startIdx: number },
): PatternResult {
  const { startIdx, ...rest } = fields;
  return {
    ...EMPTY_PATTERN,
    kind,
    timeframe: tf,
    label: LABELS[kind] + (tf === "weekly" ? " (W)" : ""),
    flag_start: bars[startIdx].date,
    flag_end: bars[bars.length - 1].date,
    pole_start: bars[startIdx].date,
    flag_bars: bars.length - 1 - startIdx,
    ...rest,
  };
}

const pt = (bars: YahooBar[], i: number, price: number, tag: string): PatternPoint =>
  ({ date: bars[i].date, price: r2(price), tag });

const pctList = (xs: number[]) => xs.map((x) => `${(x * 100).toFixed(0)}%`).join(" → ");

/** Roll daily bars up into weekly bars (Mon–Fri OHLCV aggregation). */
export function toWeekly(bars: YahooBar[]): YahooBar[] {
  const out: YahooBar[] = [];
  let cur: YahooBar | null = null;
  let curKey = "";
  for (const b of bars) {
    const d = new Date(b.date + "T00:00:00Z");
    const key = String(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000);
    if (key !== curKey) {
      if (cur) out.push(cur);
      cur = { date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
      curKey = key;
    } else if (cur) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ── Shared structure helpers ─────────────────────────────────────────────────

interface Pivot { i: number; price: number; type: "H" | "L" }

/**
 * Zigzag over highs/lows starting at `from`: a swing is confirmed once price
 * reverses by `pct`. The final pivot is the extreme of the leg still in
 * progress, so it is tentative.
 */
function zigzag(bars: YahooBar[], from: number, pct: number): Pivot[] {
  const out: Pivot[] = [];
  let dir: 0 | 1 | -1 = 0;
  let hi = from, lo = from, ext = from;
  for (let i = from + 1; i < bars.length; i++) {
    const b = bars[i];
    if (dir === 0) {
      if (b.high > bars[hi].high) hi = i;
      if (b.low < bars[lo].low) lo = i;
      if (bars[hi].high / bars[lo].low - 1 >= pct) {
        if (hi > lo) { out.push({ i: lo, price: bars[lo].low, type: "L" }); dir = 1; ext = hi; }
        else { out.push({ i: hi, price: bars[hi].high, type: "H" }); dir = -1; ext = lo; }
      }
    } else if (dir === 1) {
      if (b.high >= bars[ext].high) ext = i;
      else if (b.low <= bars[ext].high * (1 - pct)) {
        out.push({ i: ext, price: bars[ext].high, type: "H" }); dir = -1; ext = i;
      }
    } else {
      if (b.low <= bars[ext].low) ext = i;
      else if (b.high >= bars[ext].low * (1 + pct)) {
        out.push({ i: ext, price: bars[ext].low, type: "L" }); dir = 1; ext = i;
      }
    }
  }
  if (dir === 1) out.push({ i: ext, price: bars[ext].high, type: "H" });
  if (dir === -1) out.push({ i: ext, price: bars[ext].low, type: "L" });
  return out;
}

function argMax(bars: YahooBar[], from: number, to: number): number {
  let best = Math.max(0, from);
  for (let i = best + 1; i <= to; i++) if (bars[i].high >= bars[best].high) best = i;
  return best;
}

function argMin(bars: YahooBar[], from: number, to: number): number {
  let best = Math.max(0, from);
  for (let i = best + 1; i <= to; i++) if (bars[i].low < bars[best].low) best = i;
  return best;
}

/** Advance into bar `idx`: its high versus the lowest low of the prior `lookback` bars. */
function priorRun(bars: YahooBar[], idx: number, lookback: number): { gain: number; from: number } {
  const from = argMin(bars, idx - lookback, idx);
  const low = bars[from].low;
  return { gain: low > 0 ? bars[idx].high / low - 1 : 0, from };
}

function avgVolume(bars: YahooBar[], from: number, to: number): number {
  return mean(bars.slice(from, to + 1).map((b) => b.volume || 0).filter((v) => v > 0));
}

const barRange = (b: YahooBar) => (b.low > 0 ? b.high / b.low - 1 : 0);

// ── Flags, High Tight Flags and Pennants ─────────────────────────────────────

interface FlagSpec {
  poleBars: [number, number];   // run-up duration (bars from pole low to pole high)
  minPoleGain: number;          // pole low → pole high
  minPoleEfficiency: number;    // net move / path length; rejects choppy drifts
  flagBars: [number, number];   // consolidation duration (bars after pole high)
  maxDepth: number;             // deepest pullback from pole high
  maxRetrace: number;           // fraction of the pole height given back
  maxDrift: number;             // regression drift of flag closes, as fraction of pivot
  maxFromPivot: number;         // how far below the pivot the last close may sit
  requireVolume: boolean;       // volume dry-up mandatory, else vol OR range contraction
}

// HTF ≈ a near-doubling in 3–9 weeks then a 2–6 week, ≤25% pullback; bull
// flags / pennants ≈ a sharp run then a 1–6 week orderly pause giving back
// roughly half the pole at most. The minimum pause length keeps 1–2 bar
// "flags" out.
const FLAG_SPECS: Record<Timeframe, { htf: FlagSpec; bull: FlagSpec }> = {
  daily: {
    htf: {
      poleBars: [15, 45], minPoleGain: 0.8, minPoleEfficiency: 0.25,
      flagBars: [10, 30], maxDepth: 0.25, maxRetrace: 0.4, maxDrift: 0.03,
      maxFromPivot: 0.15, requireVolume: true,
    },
    bull: {
      poleBars: [6, 30], minPoleGain: 0.2, minPoleEfficiency: 0.3,
      flagBars: [6, 30], maxDepth: 0.2, maxRetrace: 0.55, maxDrift: 0.04,
      maxFromPivot: 0.15, requireVolume: false,
    },
  },
  weekly: {
    htf: {
      poleBars: [3, 12], minPoleGain: 0.8, minPoleEfficiency: 0.35,
      flagBars: [3, 8], maxDepth: 0.3, maxRetrace: 0.4, maxDrift: 0.04,
      maxFromPivot: 0.18, requireVolume: true,
    },
    bull: {
      poleBars: [2, 16], minPoleGain: 0.2, minPoleEfficiency: 0.35,
      flagBars: [3, 12], maxDepth: 0.25, maxRetrace: 0.55, maxDrift: 0.05,
      maxFromPivot: 0.18, requireVolume: false,
    },
  },
};

/**
 * Anchor on the pole high (the highest high in the recent window); the
 * pause is every bar after it, so its length is set by the chart. A bull
 * pause whose highs fall while its lows rise is a pennant; otherwise a flag.
 */
function matchFlag(bars: YahooBar[], tf: Timeframe, tight: boolean): PatternResult | null {
  const s = FLAG_SPECS[tf][tight ? "htf" : "bull"];
  const n = bars.length;
  const [minFlag, maxFlag] = s.flagBars;
  const [minPole, maxPole] = s.poleBars;
  if (n < maxFlag + maxPole + 2) return null;

  const peakIdx = argMax(bars, n - 1 - maxFlag, n - 1);
  const flagLen = n - 1 - peakIdx;
  if (flagLen < minFlag) return null;
  const pivot = bars[peakIdx].high;

  const poleLowIdx = argMin(bars, peakIdx - maxPole, peakIdx - minPole);
  const poleLow = bars[poleLowIdx].low;
  if (poleLow <= 0 || peakIdx - poleLowIdx < minPole) return null;
  for (let i = poleLowIdx; i < peakIdx; i++) if (bars[i].high > pivot) return null;

  const poleGain = pivot / poleLow - 1;
  if (poleGain < s.minPoleGain) return null;

  let path = 0;
  for (let i = poleLowIdx + 1; i <= peakIdx; i++) path += Math.abs(bars[i].close - bars[i - 1].close);
  const efficiency = path > 0 ? (bars[peakIdx].close - bars[poleLowIdx].close) / path : 0;
  if (efficiency < s.minPoleEfficiency) return null;

  const flag = bars.slice(peakIdx + 1);
  const flagLowIdx = argMin(bars, peakIdx + 1, n - 1);
  const flagLow = bars[flagLowIdx].low;
  const depth = (pivot - flagLow) / pivot;
  const retrace = (pivot - flagLow) / (pivot - poleLow);
  if (depth > s.maxDepth || retrace > s.maxRetrace) return null;

  const drift = (slope(flag.map((b) => b.close)) * flagLen) / pivot;
  if (drift > s.maxDrift) return null;

  const last = bars[n - 1];
  if (last.close < pivot * (1 - s.maxFromPivot)) return null;
  if (last.close < flagLow + (pivot - flagLow) * 0.33) return null;

  const volDryUp = avgVolume(bars, peakIdx + 1, n - 1) <= avgVolume(bars, poleLowIdx + 1, peakIdx);
  const poleRange = mean(bars.slice(poleLowIdx + 1, peakIdx + 1).map(barRange));
  const rangeTight = mean(flag.map(barRange)) <= poleRange * 0.95;
  if (s.requireVolume ? !volDryUp : !(volDryUp || rangeTight)) return null;

  let kind: PatternKind = tight ? "htf" : "bull_flag";
  if (!tight && flagLen >= 4) {
    const hiSlope = (slope(flag.map((b) => b.high)) * flagLen) / pivot;
    const loSlope = (slope(flag.map((b) => b.low)) * flagLen) / pivot;
    const third = Math.max(1, Math.floor(flagLen / 3));
    const rangeOf = (xs: YahooBar[]) =>
      (Math.max(...xs.map((b) => b.high)) - Math.min(...xs.map((b) => b.low))) / pivot;
    const converging = hiSlope <= -0.02 && loSlope >= 0.01 &&
      rangeOf(flag.slice(-third)) <= rangeOf(flag.slice(0, third)) * 0.7;
    if (converging) kind = "pennant";
  }

  return result(kind, tf, bars, {
    startIdx: peakIdx,
    pole_start: bars[poleLowIdx].date,
    pivot: r2(pivot),
    pole_gain_pct: r2(poleGain * 100),
    flag_depth_pct: r2(depth * 100),
    points: [pt(bars, poleLowIdx, poleLow, "pole"), pt(bars, peakIdx, pivot, "top"), pt(bars, flagLowIdx, flagLow, "low")],
  });
}

function detectFlags(bars: YahooBar[], tf: Timeframe): PatternResult | null {
  const n = bars.length;
  if (n < (tf === "weekly" ? 30 : 50)) return null;
  const closes = bars.map((b) => b.close);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const px = bars[n - 1].close;
  if (px < e50[n - 1] * 0.99 || e21[n - 1] < e50[n - 1] * 0.97) return null;
  return matchFlag(bars, tf, true) ?? matchFlag(bars, tf, false);
}

// ── VCP (volatility contraction) ─────────────────────────────────────────────

const VCP_SPEC: Record<Timeframe, {
  span: [number, number]; zz: number; maxFirst: number; maxLast: number;
  minPrior: number; priorLookback: number; trendEma: number;
}> = {
  daily:  { span: [15, 130], zz: 0.04, maxFirst: 0.35, maxLast: 0.10, minPrior: 0.25, priorLookback: 120, trendEma: 50 },
  weekly: { span: [5, 40],   zz: 0.07, maxFirst: 0.45, maxLast: 0.12, minPrior: 0.30, priorLookback: 26,  trendEma: 30 },
};

/**
 * Two or more pullbacks from the base high, each shallower than the last,
 * with rising lows and volume drying up in the final, tightest contraction.
 */
function detectVCP(bars: YahooBar[], tf: Timeframe): PatternResult | null {
  const s = VCP_SPEC[tf];
  const n = bars.length;
  if (n < s.span[1] / 2 + s.priorLookback / 2) return null;

  const h0 = argMax(bars, n - 1 - s.span[1], n - 1);
  if (n - 1 - h0 < s.span[0]) return null;
  const prior = priorRun(bars, h0, s.priorLookback);
  if (prior.gain < s.minPrior) return null;

  const piv = zigzag(bars, h0, s.zz);
  const legs: Array<{ hi: number; lo: number; depth: number }> = [];
  for (let k = 0; k < piv.length; k++) {
    if (piv[k].type !== "H") continue;
    const next = piv[k + 1];
    if (next && next.type === "L") {
      legs.push({ hi: piv[k].i, lo: next.i, depth: (piv[k].price - next.price) / piv[k].price });
    } else if (!next && piv[k].i < n - 1) {
      // Final pullback smaller than the zigzag threshold — the tightest contraction.
      const lo = argMin(bars, piv[k].i + 1, n - 1);
      legs.push({ hi: piv[k].i, lo, depth: (piv[k].price - bars[lo].low) / piv[k].price });
    }
  }
  if (legs.length < 2) return null;

  const depths = legs.map((l) => l.depth);
  const first = depths[0];
  const lastD = depths[depths.length - 1];
  if (first > s.maxFirst || lastD > s.maxLast || lastD > first * 0.6) return null;
  for (let k = 1; k < legs.length; k++) {
    if (depths[k] > depths[k - 1] * 1.1) return null;
    if (bars[legs[k].lo].low < bars[legs[k - 1].lo].low * 0.99) return null;
  }

  const lastLeg = legs[legs.length - 1];
  const pivot = bars[lastLeg.hi].high;
  const last = bars[n - 1];
  if (last.close < bars[lastLeg.lo].low || last.close < pivot * 0.9) return null;
  if (last.close < ema(bars.map((b) => b.close), s.trendEma)[n - 1] * 0.98) return null;
  if (avgVolume(bars, lastLeg.hi, n - 1) > avgVolume(bars, legs[0].hi, legs[0].lo)) return null;

  const points: PatternPoint[] = [];
  legs.forEach((l, k) => {
    points.push(pt(bars, l.hi, bars[l.hi].high, `H${k + 1}`));
    points.push(pt(bars, l.lo, bars[l.lo].low, `L${k + 1}`));
  });
  return result("vcp", tf, bars, {
    startIdx: h0,
    pole_start: bars[prior.from].date,
    pivot: r2(pivot),
    pole_gain_pct: r2(prior.gain * 100),
    flag_depth_pct: r2(first * 100),
    note: `${legs.length}T ${pctList(depths)}`,
    points,
  });
}

// ── Cup & Handle ─────────────────────────────────────────────────────────────

const CUP_SPEC: Record<Timeframe, {
  cup: [number, number]; handle: [number, number]; depth: [number, number];
  handleDepth: [number, number]; minPrior: number; priorLookback: number;
  rimK: number; minR2: number; trendEma: number;
}> = {
  daily: {
    cup: [35, 160], handle: [5, 25], depth: [0.12, 0.35], handleDepth: [0.03, 0.15],
    minPrior: 0.25, priorLookback: 120, rimK: 5, minR2: 0.55, trendEma: 50,
  },
  weekly: {
    cup: [7, 65], handle: [2, 8], depth: [0.12, 0.45], handleDepth: [0.04, 0.2],
    minPrior: 0.3, priorLookback: 26, rimK: 2, minR2: 0.55, trendEma: 30,
  },
};

interface Cup { L: number; bottomIdx: number; depth: number; fit: number; priorFrom: number; priorGain: number }

/**
 * Best rounded (U-shaped) cup whose right rim is bar `R`. Roundness is checked
 * by fitting a parabola to the cup's closes: it must curve upward, fit well,
 * bottom out near the middle, and spend real time near its lows (a V spends
 * almost none). `floorFor` is a handle low that must stay in the cup's upper half.
 */
function findCup(bars: YahooBar[], tf: Timeframe, R: number, maxRimGap: number, floorFor?: number): Cup | null {
  const s = CUP_SPEC[tf];
  const rightRim = bars[R].high;
  let best: Cup | null = null;
  let maxBetween = 0; // highest high strictly between L and R
  for (let L = R - 1; L >= Math.max(s.rimK, R - s.cup[1]); L--) {
    if (L < R - 1) maxBetween = Math.max(maxBetween, bars[L + 1].high);
    if (R - L < s.cup[0]) continue;
    const leftRim = bars[L].high;
    if (maxBetween > leftRim || maxBetween > rightRim) continue;
    let isSwing = true;
    for (let j = L - s.rimK; j < L; j++) if (bars[j].high > leftRim) isSwing = false;
    if (!isSwing) continue;
    if (rightRim < leftRim * (1 - maxRimGap) || rightRim > leftRim * 1.05) continue;

    const bottomIdx = argMin(bars, L + 1, R - 1);
    const bottomPos = (bottomIdx - L) / (R - L);
    if (bottomPos < 0.25 || bottomPos > 0.75) continue;
    const bottom = bars[bottomIdx].low;
    const depth = (leftRim - bottom) / leftRim;
    if (depth < s.depth[0] || depth > s.depth[1]) continue;
    if (floorFor != null && floorFor < bottom + (rightRim - bottom) * 0.5) continue;

    const cup = bars.slice(L, R + 1);
    const fit = quadFit(cup.map((b) => b.close / leftRim));
    if (fit.a <= 0 || fit.r2 < s.minR2) continue;
    const vertex = -fit.b / (2 * fit.a);
    if (vertex < 0.25 || vertex > 0.75) continue;
    const lowerThird = bottom + (leftRim - bottom) / 3;
    if (cup.filter((b) => b.close <= lowerThird).length / cup.length < 0.3) continue;

    const prior = priorRun(bars, L, s.priorLookback);
    if (prior.gain < s.minPrior) continue;

    if (!best || fit.r2 > best.fit) {
      best = { L, bottomIdx, depth, fit: fit.r2, priorFrom: prior.from, priorGain: prior.gain };
    }
  }
  return best;
}

/**
 * A rounded cup followed by a short handle that drifts down in the upper
 * half of the cup on lighter volume. If price is still climbing the right
 * side and is already back near the left rim, report the cup on its own
 * (handle not formed yet) — the left rim is then the pivot.
 */
function detectCupHandle(bars: YahooBar[], tf: Timeframe): PatternResult | null {
  const s = CUP_SPEC[tf];
  const n = bars.length;
  if (n < s.cup[0] + s.handle[0] + s.priorLookback / 2) return null;
  const last = bars[n - 1];
  if (last.close < ema(bars.map((b) => b.close), s.trendEma)[n - 1] * 0.97) return null;

  const R = argMax(bars, n - 1 - s.handle[1], n - 1);
  const handleLen = n - 1 - R;
  const rightRim = bars[R].high;

  if (handleLen >= s.handle[0]) {
    const handleLowIdx = argMin(bars, R + 1, n - 1);
    const handleLow = bars[handleLowIdx].low;
    const handleDepth = (rightRim - handleLow) / rightRim;
    const handle = bars.slice(R + 1);
    const descending =
      (slope(handle.map((b) => b.high)) * handleLen) / rightRim <= 0 &&
      (slope(handle.map((b) => b.close)) * handleLen) / rightRim <= 0.01;
    const quiet = avgVolume(bars, R + 1, n - 1) <= avgVolume(bars, R - s.cup[0], R) * 1.1;
    if (handleDepth >= s.handleDepth[0] && handleDepth <= s.handleDepth[1] && descending && quiet) {
      const cup = findCup(bars, tf, R, 0.1, handleLow);
      if (cup && handleLen <= (R - cup.L) * 0.5) {
        return result("cup_handle", tf, bars, {
          startIdx: cup.L,
          pole_start: bars[cup.priorFrom].date,
          pivot: r2(rightRim),
          pole_gain_pct: r2(cup.priorGain * 100),
          flag_depth_pct: r2(cup.depth * 100),
          note: `cup ${R - cup.L} / handle ${handleLen} bars, handle −${(handleDepth * 100).toFixed(0)}%`,
          points: [
            pt(bars, cup.L, bars[cup.L].high, "left rim"),
            pt(bars, cup.bottomIdx, bars[cup.bottomIdx].low, "bottom"),
            pt(bars, R, rightRim, "right rim"),
            pt(bars, handleLowIdx, handleLow, "handle"),
          ],
        });
      }
    }
  }

  // No handle yet: right side has just climbed back to within 6% of the left rim.
  const R2 = argMax(bars, n - 3, n - 1);
  const cup = findCup(bars, tf, R2, 0.06);
  if (!cup) return null;
  const leftRim = bars[cup.L].high;
  if (last.close < leftRim * 0.92) return null;
  return result("cup", tf, bars, {
    startIdx: cup.L,
    pole_start: bars[cup.priorFrom].date,
    pivot: r2(Math.max(leftRim, bars[R2].high)),
    pole_gain_pct: r2(cup.priorGain * 100),
    flag_depth_pct: r2(cup.depth * 100),
    note: `cup ${R2 - cup.L} bars, handle not formed`,
    points: [
      pt(bars, cup.L, leftRim, "left rim"),
      pt(bars, cup.bottomIdx, bars[cup.bottomIdx].low, "bottom"),
      pt(bars, R2, bars[R2].high, "right side"),
    ],
  });
}

// ── Ascending Triangle ───────────────────────────────────────────────────────

const TRI_SPEC: Record<Timeframe, {
  span: [number, number]; zz: number; touchTol: number; height: [number, number];
  minPrior: number; priorLookback: number; maxFromTop: number; trendEma: number;
}> = {
  daily:  { span: [15, 100], zz: 0.03, touchTol: 0.025, height: [0.06, 0.3], minPrior: 0.15, priorLookback: 100, maxFromTop: 0.06, trendEma: 50 },
  weekly: { span: [5, 40],   zz: 0.05, touchTol: 0.035, height: [0.08, 0.35], minPrior: 0.2, priorLookback: 26,  maxFromTop: 0.08, trendEma: 30 },
};

/** Flat resistance tested at least twice, with a series of higher lows pressing into it. */
function detectAscTriangle(bars: YahooBar[], tf: Timeframe): PatternResult | null {
  const s = TRI_SPEC[tf];
  const n = bars.length;
  if (n < s.span[1]) return null;

  const piv = zigzag(bars, n - 1 - s.span[1], s.zz);
  const highs = piv.filter((p) => p.type === "H");
  if (highs.length < 2) return null;
  const top = Math.max(...highs.map((p) => p.price));
  const touches = highs.filter((p) => p.price >= top * (1 - s.touchTol));
  if (touches.length < 2) return null;

  const start = touches[0].i;
  const baseLen = n - 1 - start;
  if (baseLen < s.span[0] || touches[touches.length - 1].i - start < s.span[0] * 0.4) return null;

  const lows = piv.filter((p) => p.type === "L" && p.i > start);
  if (lows.length < 2) return null;
  for (let k = 1; k < lows.length; k++) if (lows[k].price < lows[k - 1].price * 1.01) return null;
  if (!lows.some((l) => l.i < touches[touches.length - 1].i)) return null;

  const height = (top - lows[0].price) / top;
  if (height < s.height[0] || height > s.height[1]) return null;
  if ((top - lows[lows.length - 1].price) / top > height * 0.7) return null;

  const last = bars[n - 1];
  if (last.close < top * (1 - s.maxFromTop) || last.close < lows[lows.length - 1].price) return null;
  if (last.close < ema(bars.map((b) => b.close), s.trendEma)[n - 1] * 0.97) return null;
  const prior = priorRun(bars, start, s.priorLookback);
  if (prior.gain < s.minPrior) return null;

  return result("asc_triangle", tf, bars, {
    startIdx: start,
    pole_start: bars[prior.from].date,
    pivot: r2(top),
    pole_gain_pct: r2(prior.gain * 100),
    flag_depth_pct: r2(height * 100),
    note: `${touches.length} tests of ${top.toFixed(2)}, ${lows.length} higher lows`,
    points: [
      ...touches.map((p, k) => pt(bars, p.i, p.price, `T${k + 1}`)),
      ...lows.map((p, k) => pt(bars, p.i, p.price, `L${k + 1}`)),
    ],
  });
}

// ── Inverse Head & Shoulders ─────────────────────────────────────────────────

/** Indices of confirmed swing lows: lower than `k` bars on each side. */
function swingLows(bars: YahooBar[], k: number): number[] {
  const out: number[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let ok = true;
    for (let j = i - k; j < i && ok; j++) if (bars[j].low <= bars[i].low) ok = false;
    for (let j = i + 1; j <= i + k && ok; j++) if (bars[j].low < bars[i].low) ok = false;
    if (ok) out.push(i);
  }
  return out;
}

/** Three troughs, the middle deepest, shoulders roughly level, price at the neckline. */
function detectInverseHS(bars: YahooBar[], tf: Timeframe): PatternResult | null {
  const n = bars.length;
  const k = tf === "weekly" ? 2 : 4;
  const [minSpan, maxSpan] = tf === "weekly" ? [8, 70] : [20, 160];
  const minDepth = tf === "weekly" ? 0.15 : 0.12;
  const maxShoulderGap = tf === "weekly" ? 0.12 : 0.1;
  if (n < minSpan + k) return null;

  const lows = swingLows(bars, k).filter((i) => i >= n - 1 - maxSpan);
  const last = bars[n - 1];
  let best: { res: PatternResult; c: number; depth: number } | null = null;

  for (const c of lows.slice(-2)) {
    for (const b of lows.filter((i) => i < c)) {
      if (argMin(bars, b, c) !== b) continue;
      for (const a of lows.filter((i) => i < b)) {
        if (argMin(bars, a, b) !== b || c - a < minSpan) continue;
        const la = bars[a].low, lb = bars[b].low, lc = bars[c].low;
        if (lb > Math.min(la, lc) * 0.97) continue;
        if (Math.abs(la - lc) / Math.max(la, lc) > maxShoulderGap) continue;
        const ratio = (b - a) / (c - b);
        if (ratio < 0.5 || ratio > 2) continue;
        if (n - 1 - c > (c - b) * 1.5 + k) continue;
        if (Math.min(...bars.slice(c + 1).map((x) => x.low)) < lc) continue;

        const p1 = argMax(bars, a, b);
        const p2 = argMax(bars, b, c);
        if (p2 <= p1) continue;
        const h1 = bars[p1].high, h2 = bars[p2].high;
        if (Math.abs(h2 - h1) / h1 > 0.08) continue;
        const neck = (i: number) => h1 + ((h2 - h1) * (i - p1)) / (p2 - p1);

        const depth = (neck(b) - lb) / neck(b);
        if (depth < minDepth || depth > 0.5) continue;
        if (neck(a) - la < 0.3 * (neck(b) - lb) || neck(c) - lc < 0.3 * (neck(b) - lb)) continue;

        const neckNow = neck(n - 1);
        if (last.close < neckNow * 0.93 || last.close > neckNow * 1.08) continue;

        if (!best || c > best.c || (c === best.c && depth > best.depth)) {
          best = {
            c, depth,
            res: result("inverse_hs", tf, bars, {
              startIdx: a,
              pivot: r2(neckNow),
              flag_depth_pct: r2(depth * 100),
              points: [
                pt(bars, a, la, "LS"), pt(bars, p1, h1, "neck"), pt(bars, b, lb, "head"),
                pt(bars, p2, h2, "neck"), pt(bars, c, lc, "RS"),
              ],
            }),
          };
        }
      }
    }
  }
  return best ? best.res : null;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Stage-2 context for continuation bases: price above a rising long-term
 * average (200-day / 40-week) and the pivot within 20% of the 52-week high.
 * Keeps rounded bounces inside a downtrend from passing as momentum bases.
 */
function inUptrend(bars: YahooBar[], tf: Timeframe, pivot: number | null): boolean {
  const [len, lag, year] = tf === "weekly" ? [40, 4, 52] : [200, 20, 252];
  const n = bars.length;
  if (n < len + lag) return true;
  const closes = bars.map((b) => b.close);
  const sma = mean(closes.slice(n - len));
  const smaPrev = mean(closes.slice(n - len - lag, n - lag));
  const yearHigh = Math.max(...bars.slice(-year).map((b) => b.high));
  return closes[n - 1] > sma && sma >= smaPrev && (pivot ?? 0) >= yearHigh * 0.8;
}

export function patternRank(p: PatternResult): number {
  // Reversal bottoms rank below the continuation bases this page is built around.
  let s = p.kind === "htf" ? 4 : p.kind === "inverse_hs" ? 2 : 3;
  if (p.timeframe === "daily") s += 1;
  return s;
}

/**
 * Run every detector on daily AND weekly bars. `best` is the headline pattern
 * (HTF first, daily before weekly); `all` lists every match so a weekly base
 * still surfaces when a daily one is also present.
 */
export function detectPatterns(dailyBars: YahooBar[]): { best: PatternResult; all: PatternResult[] } {
  const weekly = toWeekly(dailyBars);
  const all: PatternResult[] = [];
  for (const [bars, tf] of [[dailyBars, "daily"], [weekly, "weekly"]] as const) {
    for (const detect of [detectFlags, detectVCP, detectCupHandle, detectAscTriangle, detectInverseHS]) {
      const p = detect(bars, tf);
      if (!p) continue;
      if (p.kind !== "inverse_hs" && !inUptrend(bars, tf, p.pivot)) continue;
      all.push(p);
    }
  }
  all.sort((x, y) => patternRank(y) - patternRank(x));
  return { best: all[0] ?? EMPTY_PATTERN, all };
}
