import { describe, expect, it } from 'vitest';
import { parse, query, sliceIndices, type Token } from '../src/index.js';

it('queries', () => expect(query({ a: 1 }, parse('$.a'))).toEqual([1]));

// Reference index sequences produced by Python's slice model:
//   list(range(length))[start:end:step]
// (undefined = omitted endpoint)
const REFERENCE: Array<[number, number | undefined, number | undefined, number | undefined, number[]]> = [
  [10, 5, 1, -1, [5, 4, 3, 2]],
  [10, undefined, undefined, -1, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]],
  [10, 5, undefined, -1, [5, 4, 3, 2, 1, 0]],
  [10, undefined, 2, -1, [9, 8, 7, 6, 5, 4, 3]],
  [10, 5, -1, -1, []], // explicit -1 end with negative step
  [10, undefined, -1, -1, []],
  [3, undefined, undefined, -1, [2, 1, 0]],
  [3, undefined, -1, undefined, [0, 1]], // explicit -1 end with positive step
  [3, undefined, undefined, undefined, [0, 1, 2]],
  [3, 0, 100, 1, [0, 1, 2]],
  [3, -100, undefined, 1, [0, 1, 2]],
  [3, 100, -100, -1, [2, 1, 0]],
  [3, -100, 100, -1, []],
  [1, undefined, undefined, -1, [0]],
  [1, 0, undefined, -1, [0]],
  [1, -1, undefined, undefined, [0]],
  [0, undefined, undefined, -1, []],
  [0, undefined, undefined, 1, []],
  [0, 0, 0, 1, []],
  [5, undefined, undefined, 2, [0, 2, 4]],
  [5, undefined, undefined, -2, [4, 2, 0]],
  [5, 4, 0, -2, [4, 2]],
  [5, -2, undefined, 1, [3, 4]],
  [5, undefined, -3, undefined, [0, 1]],
  [7, 2, 5, 1, [2, 3, 4]],
  [7, -5, -2, 1, [2, 3, 4]],
  [7, -2, -5, -1, [5, 4, 3]],
];

describe('sliceIndices matches the reference slice model', () => {
  for (const [len, start, end, step, expected] of REFERENCE) {
    it(`len=${len} [${start ?? ''}:${end ?? ''}:${step ?? ''}] -> [${expected}]`, () => {
      expect(sliceIndices(len, start, end, step as number | undefined)).toEqual(expected);
    });
  }
});

describe('step = 0 is rejected before it can loop', () => {
  it.each(['$[::0]', '$[1:2:0]', '$[0:0:0]'])('parse(%s) throws', (p) => {
    expect(() => parse(p)).toThrow(/step/);
  });
  it('sliceIndices throws for step 0', () => {
    expect(() => sliceIndices(3, undefined, undefined, 0)).toThrow(/step/);
    expect(() => sliceIndices(3, undefined, undefined, 0n)).toThrow(/step/);
  });
  it('query rejects a hand-built step-0 token instead of hanging', () => {
    const tokens: Token[] = [{ kind: 'root' }, { kind: 'slice', step: 0 }];
    expect(() => query([1, 2, 3], tokens)).toThrow(/step/);
  });
});

describe('negative step defaults vs explicit bounds', () => {
  const ten = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  it('$[5:1:-1] keeps both endpoints exact', () => {
    expect(query(ten, parse('$[5:1:-1]'))).toEqual([5, 4, 3, 2]);
  });
  it('$[::-1] reverses the whole array, first and last included', () => {
    expect(query(ten, parse('$[::-1]'))).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(query([1, 2, 3], parse('$[::-1]'))).toEqual([3, 2, 1]);
  });
  it('omitted end reaches index 0', () => {
    expect(query(ten, parse('$[5::-1]'))).toEqual([5, 4, 3, 2, 1, 0]);
  });
  it('explicit -1 end is not the omitted end', () => {
    expect(query(ten, parse('$[5:-1:-1]'))).toEqual([]);
    expect(query(ten, parse('$[:-1:-1]'))).toEqual([]);
    const omitted = parse('$[5::-1]')[1];
    const explicit = parse('$[5:-1:-1]')[1];
    expect(omitted).toMatchObject({ kind: 'slice', end: undefined });
    expect(explicit).toMatchObject({ kind: 'slice', end: -1n });
  });
  it('explicit -1 end with positive step drops only the last element', () => {
    expect(query([1, 2, 3], parse('$[:-1]'))).toEqual([1, 2]);
    expect(query([1, 2, 3], parse('$[:]'))).toEqual([1, 2, 3]);
  });
});

describe('edge cases', () => {
  it('empty array yields nothing for any step direction', () => {
    expect(query([] as unknown[], parse('$[::-1]'))).toEqual([]);
    expect(query([] as unknown[], parse('$[0:0]'))).toEqual([]);
    expect(query([] as unknown[], parse('$[-5:99:1]'))).toEqual([]);
    expect(query([] as unknown[], parse('$[0]'))).toEqual([]);
  });
  it('single element array', () => {
    expect(query([7], parse('$[::-1]'))).toEqual([7]);
    expect(query([7], parse('$[-1]'))).toEqual([7]);
    expect(query([7], parse('$[0]'))).toEqual([7]);
    expect(query([7], parse('$[1]'))).toEqual([]);
    expect(query([7], parse('$[1:]'))).toEqual([]);
  });
  it('out-of-range bounds are clamped once, in the step-dependent window', () => {
    expect(query([1, 2, 3], parse('$[0:100]'))).toEqual([1, 2, 3]);
    expect(query([1, 2, 3], parse('$[-100:]'))).toEqual([1, 2, 3]);
    expect(query([1, 2, 3], parse('$[100:-100:-1]'))).toEqual([3, 2, 1]);
    expect(query([1, 2, 3], parse('$[-100:100:-1]'))).toEqual([]);
    expect(query([1, 2, 3], parse('$[5:1]'))).toEqual([]);
  });
  it('nested path with a slice segment', () => {
    expect(query({ a: [1, 2, 3, 4, 5] }, parse('$.a[1:4:2]'))).toEqual([2, 4]);
    expect(query({ a: [1, 2, 3] }, parse('$.a[::-1]'))).toEqual([3, 2, 1]);
  });
  it('slice on a non-array matches nothing', () => {
    expect(query({ a: 1 }, parse('$[0:2]'))).toEqual([]);
    expect(query('x', parse('$[::-1]'))).toEqual([]);
  });
});

describe('huge indices keep bigint precision', () => {
  const HUGE = 9007199254740993n; // 2^53 + 1, not representable as a Number
  it('parse stores exact bigint bounds, unrounded by Number', () => {
    const slice = parse('$[9007199254740993:9007199254740995]')[1];
    expect(slice).toMatchObject({ start: HUGE, end: 9007199254740995n });
    const index = parse('$[9007199254740993]')[1];
    expect(index).toMatchObject({ kind: 'index', value: HUGE });
    expect(Number(HUGE)).toBe(9007199254740992); // proves the test is meaningful
  });
  it('huge bounds clamp against the real length, exactly', () => {
    expect(query([1, 2, 3], parse('$[9007199254740993:]'))).toEqual([]);
    expect(query([1, 2, 3], parse('$[-9007199254740993:]'))).toEqual([1, 2, 3]);
    // hugely negative end with negative step clamps to "before 0", like an omitted end
    expect(query([1, 2, 3], parse('$[:-9007199254740993:-1]'))).toEqual([3, 2, 1]);
    expect(query([1, 2, 3], parse('$[9007199254740993]'))).toEqual([]);
    expect(query([1, 2, 3], parse('$[-9007199254740993]'))).toEqual([]);
  });
  it('huge steps terminate after at most one element', () => {
    expect(query([1, 2, 3, 4, 5], parse('$[::9007199254740993]'))).toEqual([1]);
    expect(query([1, 2, 3, 4, 5], parse('$[::-9007199254740993]'))).toEqual([5]);
  });
  it('sliceIndices accepts bigint arguments directly', () => {
    expect(sliceIndices(3, -9007199254740993n, 9007199254740993n, 1n)).toEqual([0, 1, 2]);
    expect(sliceIndices(3, 9007199254740993n, undefined, -1n)).toEqual([2, 1, 0]);
  });
});

describe('sparse arrays', () => {
  // eslint-disable-next-line no-sparse-arrays
  const sparse: unknown[] = [0, , 2, , 4]; // holes at indices 1 and 3
  it('index sequence is unaffected; holes contribute no value', () => {
    expect(sliceIndices(5, undefined, undefined, -1)).toEqual([4, 3, 2, 1, 0]);
    expect(query(sparse, parse('$[::-1]'))).toEqual([4, 2, 0]);
    expect(query(sparse, parse('$[0:5]'))).toEqual([0, 2, 4]);
    expect(query(sparse, parse('$[1:4]'))).toEqual([2]);
  });
  it('index selector on a hole matches nothing', () => {
    expect(query(sparse, parse('$[1]'))).toEqual([]);
    expect(query(sparse, parse('$[-4]'))).toEqual([]); // normalizes to hole at 1
    expect(query(sparse, parse('$[4]'))).toEqual([4]);
    expect(query(sparse, parse('$[-1]'))).toEqual([4]);
  });
});

describe('malformed selectors are rejected', () => {
  it.each(['$[]', '$[1:2:3:4]', '$[a:b]', '$[1.5:2]', '$[1:2', 'a[1]', '$[1e3]'])(
    'parse(%s) throws',
    (p) => expect(() => parse(p)).toThrow(),
  );
  it('omitted endpoints are legal and stay undefined in the token', () => {
    expect(parse('$[1:]')[1]).toMatchObject({ kind: 'slice', start: 1n, end: undefined, step: 1n });
    expect(parse('$[::]')[1]).toMatchObject({ kind: 'slice', start: undefined, end: undefined, step: 1n });
  });
});
