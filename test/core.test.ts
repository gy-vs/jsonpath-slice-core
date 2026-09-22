import { expect, it } from 'vitest';
import { parse, query, sliceIndices } from '../src/index.js';

const arr = [0, 1, 2, 3, 4, 5];

it('queries a field', () => {
  expect(query({ a: 1 }, parse('$.a'))).toEqual([1]);
});

it('positive and negative step slices match reference index sequences', () => {
  expect(query(arr, parse('$[5:1:-1]'))).toEqual([5, 4, 3, 2]);
  expect(query(arr, parse('$[::-1]'))).toEqual([5, 4, 3, 2, 1, 0]);
  expect(query(arr, parse('$[1:5:2]'))).toEqual([1, 3]);
  expect(query(arr, parse('$[::2]'))).toEqual([0, 2, 4]);
  expect(query(arr, parse('$[-1:-4:-1]'))).toEqual([5, 4, 3]);
  expect(query(arr, parse('$[5:0:-1]'))).toEqual([5, 4, 3, 2, 1]);
  expect(query(arr, parse('$[-3::-1]'))).toEqual([3, 2, 1, 0]);
  expect(query(arr, parse('$[:-3:-1]'))).toEqual([5, 4]);
});

it('empty array yields an empty slice for any step', () => {
  expect(query([], parse('$[::-1]'))).toEqual([]);
  expect(query([], parse('$[0:10]'))).toEqual([]);
});

it('single element', () => {
  expect(query([42], parse('$[::-1]'))).toEqual([42]);
  expect(query([42], parse('$[0:0:-1]'))).toEqual([]);
  expect(query([42], parse('$[0:1]'))).toEqual([42]);
  expect(query([42], parse('$[-1::-1]'))).toEqual([42]);
});

it('out-of-bounds bounds are clamped direction-specifically', () => {
  expect(query(arr, parse('$[2:100]'))).toEqual([2, 3, 4, 5]);
  expect(query(arr, parse('$[100::-1]'))).toEqual([5, 4, 3, 2, 1, 0]);
  expect(query(arr, parse('$[:100:-1]'))).toEqual([]);
  expect(query(arr, parse('$[-100::-1]'))).toEqual([]);
  expect(query(arr, parse('$[-100:]'))).toEqual([0, 1, 2, 3, 4, 5]);
  expect(query(arr, parse('$[100:]'))).toEqual([]);
});

it('omitted end differs from explicit -1', () => {
  // Omitted end with step -1 walks all the way through index 0;
  // explicit -1 stops before the last element (index n-1).
  expect(query(arr, parse('$[-1::-1]'))).toEqual([5, 4, 3, 2, 1, 0]);
  expect(query(arr, parse('$[-1:-1:-1]'))).toEqual([]);
  expect(query(arr, parse('$[:-1:-1]'))).toEqual([]);
  // Positive direction: explicit -1 excludes the final element.
  expect(query(arr, parse('$[:]'))).toEqual([0, 1, 2, 3, 4, 5]);
  expect(query(arr, parse('$[:-1]'))).toEqual([0, 1, 2, 3, 4]);
  expect(query(arr, parse('$[0::-1]'))).toEqual([0]);
});

it('rejects step zero at parse time and at execution', () => {
  expect(() => parse('$[::0]')).toThrow(/zero/);
  expect(() => parse('$[1:2:0]')).toThrow(/zero/);
  expect(() => sliceIndices(null, null, 0n, 6n)).toThrow(/zero/);
});

it('huge bigint indices keep exact precision and clamp like the model', () => {
  const huge = 2n ** 128n;
  const tokens = parse(`$[${huge}::-1]`);
  expect(tokens[1].start).toBe(huge);
  expect(query(arr, tokens)).toEqual([5, 4, 3, 2, 1, 0]);

  const negHuge = -(2n ** 128n);
  const tokens2 = parse(`$[${negHuge}::-1]`);
  expect(tokens2[1].start).toBe(negHuge);
  expect(query(arr, tokens2)).toEqual([]);
  expect(query(arr, parse(`$[${negHuge}:]`))).toEqual([0, 1, 2, 3, 4, 5]);

  // Beyond Number.MAX_SAFE_INTEGER must not be rounded before clamping.
  const edge = BigInt(Number.MAX_SAFE_INTEGER) + 2n; // not exactly representable
  expect(query(arr, parse(`$[${edge}:]`))).toEqual([]);
  expect(sliceIndices(edge, null, 1n, 6n)).toEqual([]);
  // A normalized bound far below zero must clamp to -1, not loop.
  expect(sliceIndices(null, negHuge, -1n, 0n)).toEqual([]);
});

it('sparse arrays preserve positions, with holes reading back as undefined', () => {
  const sparse: number[] = [0, , , 3, 4, , 6]; // eslint-disable-line no-sparse-arrays
  const out = query(sparse, parse('$[::-1]')) as number[];
  expect(out.length).toBe(7);
  expect(out).toEqual([6, undefined, 4, 3, undefined, undefined, 0]);
  expect(1 in out).toBe(false);

  const sub = query(sparse, parse('$[1:6:2]')) as number[];
  expect(sub).toEqual([undefined, 3, undefined]);
  expect(0 in sub).toBe(false);
  expect(2 in sub).toBe(false);
});

it('single negative index access', () => {
  expect(query(arr, parse('$[-1]'))).toEqual([5]);
  expect(query(arr, parse('$[-6]'))).toEqual([0]);
  expect(query(arr, parse('$[-7]'))).toEqual([]);
  expect(query([], parse('$[-1]'))).toEqual([]);
});

it('slices on non-arrays produce nothing', () => {
  expect(query({ a: 1 }, parse('$[::-1]'))).toEqual([]);
  expect(query(42, parse('$[1:3]'))).toEqual([]);
});

// Independent reference model taken directly from the CPython
// PySlice_GetIndicesEx/PySlice_AdjustIndices rules: direction-specific
// defaults are applied before negative normalization, and negative step
// clamps both bounds into [-1, length-1].
function reference(
  start: bigint | null,
  end: bigint | null,
  step: bigint,
  length: bigint
): number[] {
  if (step === 0n) throw new Error('step zero');
  const normalize = (b: bigint) => (b < 0n ? b + length : b);
  let lo: bigint;
  let hi: bigint;
  if (step > 0n) {
    lo = start === null ? 0n : normalize(start);
    hi = end === null ? length : normalize(end);
    if (lo < 0n) lo = 0n;
    if (lo > length) lo = length;
    if (hi < 0n) hi = 0n;
    if (hi > length) hi = length;
  } else {
    lo = start === null ? length - 1n : normalize(start);
    hi = end === null ? -1n : normalize(end);
    if (lo < -1n) lo = -1n;
    if (lo > length - 1n) lo = length - 1n;
    if (hi < -1n) hi = -1n;
    if (hi > length - 1n) hi = length - 1n;
  }
  const out: number[] = [];
  if (step > 0n) {
    for (let i = lo; i < hi; i += step) out.push(Number(i));
  } else {
    for (let i = lo; i > hi; i += step) out.push(Number(i));
  }
  return out;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

it('fuzz: sliceIndices agrees with the reference model', () => {
  const rand = mulberry32(12345);
  const bounds: (bigint | null)[] = [
    null,
    -1n,
    0n,
    1n,
    5n,
    6n,
    7n,
    -3n,
    -6n,
    -100n,
    100n,
    2n ** 128n,
    -(2n ** 128n),
  ];
  const steps = [1n, 2n, 3n, 7n, -1n, -2n, -3n, -7n, 2n ** 64n, -(2n ** 64n)];
  const lengths = [0n, 1n, 2n, 6n, 7n, 100n];
  for (let iter = 0; iter < 5000; iter++) {
    const start = bounds[Math.floor(rand() * bounds.length)];
    const end = bounds[Math.floor(rand() * bounds.length)];
    const step = steps[Math.floor(rand() * steps.length)];
    const length = lengths[Math.floor(rand() * lengths.length)];
    expect(sliceIndices(start, end, step, length)).toEqual(
      reference(start, end, step, length)
    );
  }
});

it('exhaustive: every bound/step/length combo agrees with the model', () => {
  const bounds: (bigint | null)[] = [
    null, -1n, 0n, 1n, 5n, 6n, 7n, -3n, -6n, -100n, 100n,
    2n ** 128n, -(2n ** 128n),
  ];
  const steps = [1n, 2n, 3n, 7n, -1n, -2n, -3n, -7n, 2n ** 64n, -(2n ** 64n)];
  const lengths = [0n, 1n, 2n, 6n, 7n, 100n];
  for (const start of bounds) {
    for (const end of bounds) {
      for (const step of steps) {
        for (const length of lengths) {
          expect(sliceIndices(start, end, step, length)).toEqual(
            reference(start, end, step, length)
          );
        }
      }
    }
  }
});
