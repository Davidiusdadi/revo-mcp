/**
 * Wyhash as Zig's std.hash.Wyhash computes it (one-shot `hash`), in BigInt.
 * scripts/segment-cases.ts splits its words by this hash of their UTF-8 bytes
 * with seed 0; the learned segmenter weights were fitted on that split, so it
 * must stay bit-for-bit the same.
 */
const MASK = (1n << 64n) - 1n;
const SECRET = [0xa0761d6478bd642fn, 0xe7037ed1a0b428dbn, 0x8ebc6af09c88c6e3n, 0x589965cc75374cc3n] as const;

/** The 128-bit product of two u64s, folded: low half xor high half. */
const mix = (a: bigint, b: bigint): bigint => {
  const x = a * b;
  return (x & MASK) ^ (x >> 64n);
};

export function wyhash(input: Uint8Array, seed = 0n): bigint {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const r4 = (at: number) => BigInt(view.getUint32(at, true));
  const r8 = (at: number) => view.getBigUint64(at, true);
  const len = input.length;
  seed &= MASK;

  let s0 = seed ^ mix(seed ^ SECRET[0], SECRET[1]);
  let s1 = s0;
  let s2 = s0;
  let a: bigint;
  let b: bigint;
  if (len <= 16) {
    if (len >= 4) {
      const end = len - 4;
      const quarter = (len >> 3) << 2;
      a = (r4(0) << 32n) | r4(quarter);
      b = (r4(end) << 32n) | r4(end - quarter);
    } else if (len > 0) {
      a = (BigInt(input[0]) << 16n) | (BigInt(input[len >> 1]) << 8n) | BigInt(input[len - 1]);
      b = 0n;
    } else {
      a = b = 0n;
    }
  } else {
    let i = 0;
    if (len >= 48) {
      for (; i + 48 < len; i += 48) {
        s0 = mix(r8(i) ^ SECRET[1], r8(i + 8) ^ s0);
        s1 = mix(r8(i + 16) ^ SECRET[2], r8(i + 24) ^ s1);
        s2 = mix(r8(i + 32) ^ SECRET[3], r8(i + 40) ^ s2);
      }
      s0 ^= s1 ^ s2;
    }
    for (; i + 16 < len; i += 16) s0 = mix(r8(i) ^ SECRET[1], r8(i + 8) ^ s0);
    a = r8(len - 16);
    b = r8(len - 8);
  }

  const x = (a ^ SECRET[1]) * (b ^ s0);
  return mix((x & MASK) ^ SECRET[0] ^ BigInt(len), (x >> 64n) ^ SECRET[1]);
}

const utf8 = new TextEncoder();

/** The hash of a string's UTF-8 bytes, seed 0: the hash the segment-case split was made with. */
export const hashString = (text: string): bigint => wyhash(utf8.encode(text));
