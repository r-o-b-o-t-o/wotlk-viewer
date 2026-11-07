/**
 * The Storm cipher the MPQ format is built on: one table drives both the filename hashes that index
 * the hash table and the block cipher that protects the hash and block tables themselves.
 */

/** Storm's 0x500-entry table, generated from the same seeded LCG the client uses. */
const TABLE = /* @__PURE__ */ (() => {
	const t = new Uint32Array(0x500);
	let seed = 0x00100001;
	for (let i = 0; i < 0x100; i++) {
		for (let j = i; j < 0x500; j += 0x100) {
			seed = (seed * 125 + 3) % 0x2aaaab;
			const hi = (seed & 0xffff) << 16;
			seed = (seed * 125 + 3) % 0x2aaaab;
			t[j] = (hi | (seed & 0xffff)) >>> 0;
		}
	}
	return t;
})();

/** Which of the table's five sections a hash draws on. */
export const HashType = {
	TableOffset: 0,
	NameA: 1,
	NameB: 2,
	FileKey: 3,
} as const;

/** Archive paths are upper-case and backslash-separated however they were written. */
function normalize(name: string): string {
	return name.toUpperCase().replace(/\//g, "\\");
}

export function hashString(name: string, type: number): number {
	let seed1 = 0x7fed7fed;
	let seed2 = 0xeeeeeeee;
	for (const ch of normalize(name)) {
		const c = ch.charCodeAt(0) & 0xff;
		seed1 = (TABLE[type * 0x100 + c] ^ ((seed1 + seed2) >>> 0)) >>> 0;
		seed2 = (c + seed1 + seed2 + (seed2 << 5) + 3) >>> 0;
	}
	return seed1 >>> 0;
}

/** Decrypts a buffer in place, a uint32 at a time; a trailing partial word is left alone. */
export function decrypt(buf: Buffer, key: number): void {
	let seed = 0xeeeeeeee;
	const words = buf.length >> 2;
	for (let i = 0; i < words; i++) {
		seed = (seed + TABLE[0x400 + (key & 0xff)]) >>> 0;
		const plain = (buf.readUInt32LE(i * 4) ^ ((key + seed) >>> 0)) >>> 0;
		buf.writeUInt32LE(plain, i * 4);
		key = ((((~key >>> 0) << 0x15) + 0x11111111) | (key >>> 0x0b)) >>> 0;
		seed = (plain + seed + (seed << 5) + 3) >>> 0;
	}
}

/**
 * The key an encrypted file's sectors are enciphered with. It is derived from the base name alone,
 * and `fixKey` (MPQ_FILE_FIX_KEY) folds in where the file sits, so moving it rekeys it.
 */
export function fileKey(name: string, blockOffset: number, fileSize: number, fixKey: boolean): number {
	const base = normalize(name).split("\\").pop() ?? name;
	const key = hashString(base, HashType.FileKey);
	if (!fixKey) return key;
	return (((key + blockOffset) >>> 0) ^ fileSize) >>> 0;
}
