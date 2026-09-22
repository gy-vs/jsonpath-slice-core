export type Slice = {
  kind: 'slice';
  start: bigint | null;
  end: bigint | null;
  step: bigint;
};

export type Token = {
  kind: 'root' | 'field' | 'index' | 'slice' | 'wildcard';
  value?: string;
  index?: bigint;
  start?: bigint | null;
  end?: bigint | null;
  step?: bigint;
};

function parseInteger(raw: string): bigint {
  if (!/^[+-]?[0-9]+$/.test(raw)) {
    throw new Error(`invalid integer in slice: ${raw}`);
  }
  return BigInt(raw);
}

// Parse the contents of a single bracket, e.g. `1`, `5:1:-1` or `*`.
function parseBracket(body: string): Token {
  const text = body.trim();
  if (text.includes(':')) {
    const parts = text.split(':');
    if (parts.length > 3) {
      throw new Error(`invalid slice: ${text}`);
    }
    const pieces = [parts[0].trim(), parts[1].trim(), parts[2]?.trim() ?? ''];
    const start = pieces[0] === '' ? null : parseInteger(pieces[0]);
    const end = pieces[1] === '' ? null : parseInteger(pieces[1]);
    const step = pieces[2] === '' ? 1n : parseInteger(pieces[2]);
    if (step === 0n) {
      throw new Error('slice step cannot be zero');
    }
    return { kind: 'slice', start, end, step };
  }
  if (text === '*') {
    return { kind: 'wildcard' };
  }
  return { kind: 'index', index: parseInteger(text) };
}

// Split the path after `$` into dot-separated segments, keeping
// bracket contents (`[...]`) attached as their own segments.
function splitSegments(path: string): string[] {
  const segments: string[] = [];
  let buffer = '';
  let depth = 0;
  for (const ch of path) {
    if (ch === '[') {
      if (buffer !== '') {
        segments.push(buffer);
        buffer = '';
      }
      depth++;
      buffer = ch;
    } else if (ch === ']') {
      buffer += ch;
      depth--;
      if (depth === 0) {
        segments.push(buffer);
        buffer = '';
      }
    } else if (ch === '.' && depth === 0) {
      if (buffer !== '') {
        segments.push(buffer);
        buffer = '';
      }
    } else {
      buffer += ch;
    }
  }
  if (buffer !== '') {
    segments.push(buffer);
  }
  return segments;
}

export function parse(path: string): Token[] {
  if (!path.startsWith('$')) {
    throw new Error('path must start with $');
  }
  const out: Token[] = [{ kind: 'root' }];
  for (const segment of splitSegments(path.slice(1))) {
    if (segment.startsWith('[') && segment.endsWith(']')) {
      out.push(parseBracket(segment.slice(1, -1)));
    } else if (segment === '*') {
      out.push({ kind: 'wildcard' });
    } else if (segment.includes(':')) {
      out.push(parseBracket(segment));
    } else {
      out.push({ kind: 'field', value: segment });
    }
  }
  return out;
}

// Resolve a negative index against length n; positive indices pass through.
function normalizeBound(bound: bigint, n: bigint): bigint {
  return bound < 0n ? bound + n : bound;
}

// Compute the selected source-index sequence for a slice over an array of
// length n, following Python/CPython slice semantics entirely in bigint so
// huge integer literals never lose precision through Number conversion.
//
// Positive and negative steps get *different* defaults and *different*
// clamps; omitted end stays at its negative-step sentinel (-1) instead of
// being clamped to n, which is what makes `[::-1]` include index 0 and
// `[5:1:-1]` include both ends.
export function sliceIndices(
  start: bigint | null,
  end: bigint | null,
  step: bigint,
  length: bigint
): number[] {
  if (step === 0n) {
    throw new Error('slice step cannot be zero');
  }
  let lo: bigint;
  let hi: bigint; // exclusive upper bound of the index range
  if (step > 0n) {
    lo = start === null ? 0n : normalizeBound(start, length);
    hi = end === null ? length : normalizeBound(end, length);
    if (lo < 0n) lo = 0n;
    else if (lo > length) lo = length;
    if (hi < 0n) hi = 0n;
    else if (hi > length) hi = length;
  } else {
    // Defaults are applied BEFORE negative normalization, exactly like
    // PySlice_GetIndicesEx: start defaults to length-1, end to -1 (the
    // -1 must survive normalization so the walk can reach index 0).
    lo = start === null ? length - 1n : normalizeBound(start, length);
    hi = end === null ? -1n : normalizeBound(end, length);
    // Negative step clamps into [-1, length-1] on BOTH sides: a normalized
    // bound that is still negative becomes -1 (empty range), never a huge
    // negative value the walk would take eons to reach.
    if (lo < -1n) lo = -1n;
    else if (lo > length - 1n) lo = length - 1n;
    if (hi < -1n) hi = -1n;
    else if (hi > length - 1n) hi = length - 1n;
  }

  const indices: number[] = [];
  if (step > 0n) {
    for (let i = lo; i < hi; i += step) {
      indices.push(Number(i));
    }
  } else {
    for (let i = lo; i > hi; i += step) {
      indices.push(Number(i));
    }
  }
  return indices;
}

function applySlice(item: unknown, token: Slice): unknown[] {
  if (!Array.isArray(item)) {
    return [];
  }
  const indices = sliceIndices(token.start, token.end, token.step, BigInt(item.length));
  // Build the result position by position so that holes in a sparse source
  // stay holes at the corresponding destination (like Array.prototype.slice),
  // instead of being materialized as explicit undefined.
  const result: unknown[] = new Array(indices.length);
  indices.forEach((src, dst) => {
    if (src in item) {
      result[dst] = item[src];
    }
  });
  return result;
}

function normalizeIndex(index: bigint, length: number): number | null {
  const n = BigInt(length);
  const i = index < 0n ? index + n : index;
  if (i < 0n || i >= n) {
    return null;
  }
  return Number(i);
}

function select(item: unknown, token: Token): unknown[] {
  if (token.kind === 'wildcard') {
    return item && typeof item === 'object'
      ? Object.values(item as Record<string, unknown>)
      : [];
  }
  if (token.kind === 'field') {
    return item && typeof item === 'object'
      ? [(item as Record<string, unknown>)[String(token.value)]]
      : [];
  }
  if (token.kind === 'index') {
    if (!Array.isArray(item)) {
      return [];
    }
    const i = normalizeIndex(token.index ?? 0n, item.length);
    return i === null ? [] : [item[i]];
  }
  return applySlice(item, token as Slice);
}

export function query(value: unknown, tokens: Token[]): unknown[] {
  let current: unknown[] = [value];
  for (const token of tokens.slice(1)) {
    // Manual append instead of flatMap: flatMap iterates sparse results with
    // for-of, which skips holes and would collapse their length away.
    const next: unknown[] = [];
    for (const item of current) {
      const picked = select(item, token);
      // Index-wise append: both spread and for-of materialize holes,
      // which would destroy sparseness and shift later positions.
      const base = next.length;
      next.length = base + picked.length;
      for (let i = 0; i < picked.length; i++) {
        if (i in picked) {
          next[base + i] = picked[i];
        }
      }
    }
    current = next;
  }
  return current;
}
