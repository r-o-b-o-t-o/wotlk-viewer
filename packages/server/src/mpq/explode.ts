/**
 * PKWARE Data Compression Library "explode", the other half of MPQ's compression alongside zlib.
 * Ported from zlib's `contrib/blast.c`; the tables are the format's own, not derived.
 */

const MAX_BITS = 13;

// Run-length coded code lengths: each byte is (repeat - 1) << 4 | length.
const LITERAL_LENGTHS = [
	11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8, 9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11,
	7, 9, 11, 12, 6, 7, 22, 5, 7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12, 8, 12, 5, 38, 5, 38,
	5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27, 44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12,
	45, 44, 173,
];
const LENGTH_LENGTHS = [2, 35, 36, 53, 38, 23];
const DISTANCE_LENGTHS = [2, 20, 53, 230, 247, 151, 248];
const LENGTH_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];

interface Huffman {
	/** How many codes there are of each bit length. */
	count: Int32Array;
	/** Symbols ordered canonically, shortest code first. */
	symbol: Int32Array;
}

function construct(rep: readonly number[]): Huffman {
	const lengths: number[] = [];
	for (const byte of rep) {
		const len = byte & 15;
		for (let left = (byte >> 4) + 1; left > 0; left--) lengths.push(len);
	}
	const count = new Int32Array(MAX_BITS + 1);
	for (const len of lengths) count[len]++;
	const offs = new Int32Array(MAX_BITS + 1);
	for (let len = 1; len < MAX_BITS; len++) offs[len + 1] = offs[len] + count[len];
	const symbol = new Int32Array(lengths.length);
	for (let s = 0; s < lengths.length; s++) if (lengths[s] !== 0) symbol[offs[lengths[s]]++] = s;
	return { count, symbol };
}

const LITERAL_CODE = /* @__PURE__ */ construct(LITERAL_LENGTHS);
const LENGTH_CODE = /* @__PURE__ */ construct(LENGTH_LENGTHS);
const DISTANCE_CODE = /* @__PURE__ */ construct(DISTANCE_LENGTHS);

/** Inflates one DCL stream. `expected` bounds the output, which the caller already knows. */
export function explode(input: Buffer, expected: number): Buffer {
	const out = Buffer.alloc(expected);
	let inPos = 0;
	let bitBuf = 0;
	let bitCount = 0;
	let outPos = 0;

	const bits = (need: number): number => {
		let val = bitBuf;
		while (bitCount < need) {
			if (inPos >= input.length) throw new Error("truncated DCL stream");
			val |= input[inPos++] << bitCount;
			bitCount += 8;
		}
		bitBuf = val >> need;
		bitCount -= need;
		return val & ((1 << need) - 1);
	};

	// Codes are stored inverted and MSB-first, so the bits are complemented as they are shifted in.
	const decode = (h: Huffman): number => {
		let len = 1;
		let code = 0;
		let first = 0;
		let index = 0;
		let buf = bitBuf;
		let left = bitCount;
		let next = 1;
		for (;;) {
			while (left-- > 0) {
				code |= (buf & 1) ^ 1;
				buf >>= 1;
				const count = h.count[next++];
				if (code < first + count) {
					bitBuf = buf;
					bitCount = (bitCount - len) & 7;
					return h.symbol[index + (code - first)];
				}
				index += count;
				first = (first + count) << 1;
				code <<= 1;
				len++;
			}
			left = MAX_BITS + 1 - len;
			if (left === 0 || inPos >= input.length) throw new Error("bad DCL code");
			buf = input[inPos++];
			if (left > 8) left = 8;
		}
	};

	const coded = bits(8);
	if (coded > 1) throw new Error(`bad DCL literal flag ${coded}`);
	const dictBits = bits(8);
	if (dictBits < 4 || dictBits > 6) throw new Error(`bad DCL dictionary size ${dictBits}`);

	while (outPos < expected) {
		if (bits(1)) {
			const lenSymbol = decode(LENGTH_CODE);
			const length = LENGTH_BASE[lenSymbol] + bits(LENGTH_EXTRA[lenSymbol]);
			if (length === 519) break; // the end-of-stream code
			const shift = length === 2 ? 2 : dictBits;
			const distance = ((decode(DISTANCE_CODE) << shift) | bits(shift)) + 1;
			if (distance > outPos) throw new Error("DCL distance before start of output");
			for (let i = 0; i < length && outPos < expected; i++, outPos++) out[outPos] = out[outPos - distance];
		} else {
			out[outPos++] = coded ? decode(LITERAL_CODE) : bits(8);
		}
	}
	return out;
}
