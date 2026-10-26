/** First index i such that arr[i][key] >= value (arr sorted ascending by key). */
export function lowerBound(arr, value, key = 't') {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][key] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function meanSd(values) {
  const n = values.length;
  if (!n) return { mean: 0, sd: 0, n };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, sd, n };
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Signed milliseconds, e.g. "+12 ms" / "−4 ms". */
export function fmtMs(ms, digits = 0) {
  const v = Number(ms.toFixed(digits));
  if (v === 0) return `±0 ms`;
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)} ms`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const basename = p => p.replace(/\\/g, '/').split('/').pop();
