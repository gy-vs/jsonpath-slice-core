/**
 * Minimal JSONPath engine: root, dot/bracket fields, wildcard, array index
 * and array slice selectors.
 *
 * Slice semantics follow the Python / RFC 9535 reference model:
 *  - default bounds depend on the sign of step: start=0/end=len for
 *    step>0, but start=len-1/end="one before 0" for step<0;
 *  - a negative bound is normalized exactly once (bound += len) and then
 *    clamped exactly once, into [0, len] for step>0 and [-1, len-1] for
 *    step<0;
 *  - an omitted end is not an explicit -1: for step<0 the omitted end is
 *    -len-1, which clamps to -1 and keeps index 0 reachable, while an
 *    explicit -1 normalizes to len-1;
 *  - step 0 is rejected at compile time (parse) and again before
 *    execution (sliceIndices), so it can never spin a loop;
 *  - bounds are arbitrary-precision: they are parsed from text straight
 *    into bigint and normalized/clamped in bigint, never routed through
 *    Number, so huge indices keep their exact value until clamped
 *    against the actual array length.
 */

export type Token =
  | { kind: 'root' }
  | { kind: 'field'; value: string }
  | { kind: 'index'; value: number | bigint }
  | { kind: 'wildcard' }
  | { kind: 'slice'; start?: number | bigint; end?: number | bigint; step: number | bigint };

const INTEGER = /^-?\d+$/;

function toBigInt(value: number | bigint, what: string): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isInteger(value)) throw new Error(`${what} must be an integer, got ${value}`);
  return BigInt(value);
}

function parseBracket(inner: string): Token {
  const text = inner.trim();
  if (text === '*') return { kind: 'wildcard' };
  if (!text.includes(':')) {
    if (!INTEGER.test(text)) throw new Error(`invalid index selector [${inner}]`);
    return { kind: 'index', value: BigInt(text) };
  }
  const parts = text.split(':');
  if (parts.length > 3) throw new Error(`invalid slice selector [${inner}]`);
  const bound = (raw: string | undefined, what: string): bigint | undefined => {
    const t = (raw ?? '').trim();
    if (t === '') return undefined; // omitted: resolved later from the step sign
    if (!INTEGER.test(t)) throw new Error(`invalid slice ${what} in [${inner}]`);
    return BigInt(t);
  };
  const start = bound(parts[0], 'start');
  const end = bound(parts[1], 'end');
  const step = bound(parts[2], 'step') ?? 1n;
  if (step === 0n) throw new Error(`slice step must not be 0 in [${inner}]`);
  return { kind: 'slice', start, end, step };
}

export function parse(path: string): Token[] {
  if (!path.startsWith('$')) throw new Error('path must start at the root $');
  const tokens: Token[] = [{ kind: 'root' }];
  let i = 1;
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      i += 1;
      const from = i;
      while (i < path.length && path[i] !== '.' && path[i] !== '[') i += 1;
      const name = path.slice(from, i);
      if (name === '') throw new Error(`empty segment in ${path}`);
      tokens.push(name === '*' ? { kind: 'wildcard' } : { kind: 'field', value: name });
    } else if (ch === '[') {
      const close = path.indexOf(']', i);
      if (close < 0) throw new Error(`unclosed bracket in ${path}`);
      tokens.push(parseBracket(path.slice(i + 1, close)));
      i = close + 1;
    } else {
      throw new Error(`unexpected '${ch}' in ${path}`);
    }
  }
  return tokens;
}

const clamp = (v: bigint, lo: bigint, hi: bigint): bigint => (v < lo ? lo : v > hi ? hi : v);

/**
 * Index sequence produced by [start:end:step] over an array of `length`
 * elements — the reference slice model. Mapping indices to values
 * (including sparse-array holes) happens in query().
 */
export function sliceIndices(
  length: number,
  start?: number | bigint,
  end?: number | bigint,
  step: number | bigint = 1n,
): number[] {
  if (!Number.isInteger(length) || length < 0) throw new RangeError(`bad length ${length}`);
  const len = BigInt(length);
  const st = toBigInt(step, 'step');
  if (st === 0n) throw new Error('slice step must not be 0');
  const s0 = start === undefined ? undefined : toBigInt(start, 'start');
  const e0 = end === undefined ? undefined : toBigInt(end, 'end');
  const out: number[] = [];
  if (st > 0n) {
    // Defaults 0..len, clamp window [0, len].
    const s = clamp(s0 === undefined ? 0n : s0 < 0n ? s0 + len : s0, 0n, len);
    const e = clamp(e0 === undefined ? len : e0 < 0n ? e0 + len : e0, 0n, len);
    for (let i = s; i < e; i += st) out.push(Number(i));
  } else {
    // Defaults (len-1)..(-len-1), clamp window [-1, len-1]. The omitted
    // end -len-1 clamps to -1 so index 0 is still visited; an explicit
    // end of -1 normalizes to len-1 instead, which is why the two differ.
    const s = clamp(s0 === undefined ? len - 1n : s0 < 0n ? s0 + len : s0, -1n, len - 1n);
    const e = clamp(e0 === undefined ? -len - 1n : e0 < 0n ? e0 + len : e0, -1n, len - 1n);
    for (let i = s; i > e; i += st) out.push(Number(i));
  }
  return out;
}

export function query(value: unknown, tokens: Token[]): unknown[] {
  let current: unknown[] = [value];
  for (const token of tokens.slice(1)) {
    current = current.flatMap((item) => {
      if (token.kind === 'wildcard' && item && typeof item === 'object') return Object.values(item);
      if (token.kind === 'field' && item && typeof item === 'object')
        return [(item as Record<string, unknown>)[token.value]];
      if (token.kind === 'index' && Array.isArray(item)) {
        const len = BigInt(item.length);
        const raw = toBigInt(token.value, 'index');
        const idx = raw < 0n ? raw + len : raw;
        if (idx < 0n || idx >= len) return [];
        const i = Number(idx);
        return i in item ? [item[i]] : []; // holes in sparse arrays have no value
      }
      if (token.kind === 'slice' && Array.isArray(item)) {
        const out: unknown[] = [];
        for (const i of sliceIndices(item.length, token.start, token.end, token.step))
          if (i in item) out.push(item[i]); // skip holes, keep the index sequence
        return out;
      }
      return [];
    });
  }
  return current;
}
