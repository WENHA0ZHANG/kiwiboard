/** Exponential moving average series (same length as input; leading values
 *  seeded with the first close). */
export function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length === 0 || period <= 1) return values.slice();
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}

/** Least-squares slope of `ys` against bar index. */
export function slope(ys: number[]): number {
  const m = ys.length;
  if (m < 2) return 0;
  const xBar = (m - 1) / 2;
  const yBar = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < m; i++) {
    num += (i - xBar) * (ys[i] - yBar);
    den += (i - xBar) ** 2;
  }
  return den ? num / den : 0;
}

/**
 * Least-squares fit of y = a·t² + b·t + c with t spread evenly over [0, 1].
 * Returns the coefficients and R² of the fit.
 */
export function quadFit(ys: number[]): { a: number; b: number; c: number; r2: number } {
  const m = ys.length;
  if (m < 3) return { a: 0, b: 0, c: 0, r2: 0 };
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, sy = 0, sty = 0, st2y = 0;
  for (let i = 0; i < m; i++) {
    const t = i / (m - 1);
    const y = ys[i];
    s0 += 1; s1 += t; s2 += t * t; s3 += t ** 3; s4 += t ** 4;
    sy += y; sty += t * y; st2y += t * t * y;
  }
  // Solve the 3×3 normal equations by Cramer's rule.
  const det = (m3: number[][]) =>
    m3[0][0] * (m3[1][1] * m3[2][2] - m3[1][2] * m3[2][1]) -
    m3[0][1] * (m3[1][0] * m3[2][2] - m3[1][2] * m3[2][0]) +
    m3[0][2] * (m3[1][0] * m3[2][1] - m3[1][1] * m3[2][0]);
  const A = [[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]];
  const B = [st2y, sty, sy];
  const D = det(A);
  if (!D) return { a: 0, b: 0, c: 0, r2: 0 };
  const col = (k: number) => A.map((row, r) => row.map((v, c) => (c === k ? B[r] : v)));
  const a = det(col(0)) / D;
  const b = det(col(1)) / D;
  const c = det(col(2)) / D;
  const yBar = sy / m;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < m; i++) {
    const t = i / (m - 1);
    ssRes += (ys[i] - (a * t * t + b * t + c)) ** 2;
    ssTot += (ys[i] - yBar) ** 2;
  }
  return { a, b, c, r2: ssTot ? 1 - ssRes / ssTot : 0 };
}

export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
