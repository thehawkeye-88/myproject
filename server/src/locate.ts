import type { CharRange, LocateMethod } from '@docreview/shared';

export type Located = { span: CharRange; method: LocateMethod; score: number } | null;

type Normalized = { s: string; map: number[] };

/**
 * Collapse whitespace and case, keeping a char-for-char map back into the
 * original string. Whitespace differences between what the model quotes and
 * what pdf.js produced are the single most common reason an exact match fails.
 */
export function normalize(input: string): Normalized {
  const out: string[] = [];
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      if (prevSpace || out.length === 0) continue;
      out.push(' ');
      map.push(i);
      prevSpace = true;
    } else {
      out.push(ch.toLowerCase());
      map.push(i);
      prevSpace = false;
    }
  }
  while (out.length && out[out.length - 1] === ' ') { out.pop(); map.pop(); }
  return { s: out.join(''), map };
}

function span(n: Normalized, from: number, len: number): CharRange {
  return { start: n.map[from], end: n.map[from + len - 1] + 1 };
}

const MIN_FUZZY_SCORE = 0.82;
const MAX_FUZZY_CANDIDATES = 4000;

/**
 * Find `quote` inside `text`. Three tiers, most trustworthy first. The tier is
 * reported so the UI can say *how* a value was located, not merely that it was.
 */
export function locate(text: string, quote: string, hint?: number): Located {
  const q = quote.trim();
  if (q.length < 2) return null;

  const exactAt = hint != null ? indexNear(text, q, hint) : text.indexOf(q);
  if (exactAt >= 0) return { span: { start: exactAt, end: exactAt + q.length }, method: 'exact', score: 1 };

  const nt = normalize(text);
  const nq = normalize(q);
  if (!nq.s) return null;

  const at = nt.s.indexOf(nq.s);
  if (at >= 0) return { span: span(nt, at, nq.s.length), method: 'normalized', score: 1 };

  // Fuzzy: anchor on the first character, score a same-length window.
  let best: { at: number; score: number } | null = null;
  let candidates = 0;
  const L = nq.s.length;
  for (let i = 0; i + L <= nt.s.length; i++) {
    if (nt.s[i] !== nq.s[0]) continue;
    if (++candidates > MAX_FUZZY_CANDIDATES) break;
    const score = similarity(nt.s.slice(i, i + L), nq.s);
    if (!best || score > best.score) best = { at: i, score };
    if (score === 1) break;
  }
  if (best && best.score >= MIN_FUZZY_SCORE) {
    return { span: span(nt, best.at, L), method: 'fuzzy', score: best.score };
  }
  return null;
}

function indexNear(text: string, q: string, hint: number): number {
  const window = 400;
  const from = Math.max(0, hint - window);
  const local = text.indexOf(q, from);
  if (local >= 0 && local < hint + window) return local;
  return text.indexOf(q);
}

export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

function levenshtein(a: string, b: string): number {
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
