import { open, type FileHandle } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { decrypt, fileKey, hashString, HashType } from "./crypt.js";
import { explode } from "./explode.js";

const SIGNATURE = "MPQ\x1a";
/** The header can sit at any 512-byte boundary, though all 16 archives of a 3.3.5a client start at 0. */
const HEADER_SEARCH_LIMIT = 0x100000;

const Flags = {
	/** PKWARE alone, with no codec byte in front. Unused by 3.3.5a: every packed file is Compress. */
	Implode: 0x00000100,
	/** Compressed, each chunk naming its codec in a leading byte. */
	Compress: 0x00000200,
	Encrypted: 0x00010000,
	FixKey: 0x00020000,
	SingleUnit: 0x01000000,
	/** A patch archive's tombstone: the file is gone, and lower archives must not supply it. */
	DeleteMarker: 0x02000000,
	SectorCrc: 0x04000000,
	Exists: 0x80000000,
} as const;

/**
 * Compression codecs we decode. Every packed file in a 3.3.5a client is zlib but for eight bzip2
 * ones (0x10), six of them `.skin` files; huffman, sparse and ADPCM do not appear at all.
 */
const Compression = { Zlib: 0x02, Pkware: 0x08 } as const;

/** Thrown for a file whose sectors use a codec this reader does not implement. */
export class UnsupportedCompression extends Error {
	constructor(readonly mask: number) {
		super(`unsupported MPQ compression 0x${mask.toString(16)}`);
	}
}

export interface MpqFile {
	readonly name: string;
	readonly size: number;
	/** The archive deletes this path rather than providing it. */
	readonly deleted: boolean;
}

interface Block {
	offset: number;
	compressedSize: number;
	size: number;
	flags: number;
}

/** Reads one MPQ archive: its name index, and the bytes of a file by name. */
export class MpqArchive {
	private constructor(
		readonly path: string,
		private readonly handle: FileHandle,
		private readonly hashTable: Buffer,
		private readonly blockTable: Buffer,
		private readonly hashCount: number,
		private readonly sectorSize: number,
		/** Where the header sits; every offset in the block table is relative to it. */
		private readonly base: number,
	) {}

	static async open(path: string): Promise<MpqArchive> {
		const handle = await open(path, "r");
		try {
			const base = await findHeader(handle);
			const header = Buffer.alloc(44);
			await handle.read(header, 0, 44, base);
			const sectorSize = 512 << header.readUInt16LE(14);
			// Format 1 adds the high 16 bits of each table offset, for archives past 4 GiB.
			const format = header.readUInt16LE(12);
			const hi = (value: number) => (format >= 1 ? value * 0x100000000 : 0);
			const hashPos = base + header.readUInt32LE(16) + hi(header.readUInt16LE(40));
			const blockPos = base + header.readUInt32LE(20) + hi(header.readUInt16LE(42));
			const hashCount = header.readUInt32LE(24);
			const blockCount = header.readUInt32LE(28);

			const hashTable = Buffer.alloc(hashCount * 16);
			await handle.read(hashTable, 0, hashTable.length, hashPos);
			decrypt(hashTable, hashString("(hash table)", HashType.FileKey));

			const blockTable = Buffer.alloc(blockCount * 16);
			await handle.read(blockTable, 0, blockTable.length, blockPos);
			decrypt(blockTable, hashString("(block table)", HashType.FileKey));

			return new MpqArchive(path, handle, hashTable, blockTable, hashCount, sectorSize, base);
		} catch (e) {
			await handle.close();
			throw e;
		}
	}

	close(): Promise<void> {
		return this.handle.close();
	}

	/**
	 * Every path the archive names itself. MPQ stores only hashes, so a file absent from `(listfile)`
	 * can be read but not discovered; Blizzard's own archives all carry one.
	 */
	async listFiles(): Promise<MpqFile[]> {
		const raw = await this.read("(listfile)");
		if (!raw) return [];
		const out: MpqFile[] = [];
		for (const line of raw.toString("latin1").split(/\r?\n/)) {
			const name = line.trim();
			if (!name) continue;
			const block = this.find(name);
			if (block) out.push({ name, size: block.size, deleted: (block.flags & Flags.DeleteMarker) !== 0 });
		}
		return out;
	}

	/** The block an archive path maps to, or null when the archive does not hold it. */
	private find(name: string): Block | null {
		const wantA = hashString(name, HashType.NameA);
		const wantB = hashString(name, HashType.NameB);
		const start = hashString(name, HashType.TableOffset) & (this.hashCount - 1);
		for (let i = 0; i < this.hashCount; i++) {
			const o = ((start + i) & (this.hashCount - 1)) * 16;
			const index = this.hashTable.readInt32LE(o + 12);
			if (index === -1) return null; // a never-used slot ends the probe chain
			if (index < 0) continue; // -2 is a deleted slot: keep probing
			if (this.hashTable.readUInt32LE(o) !== wantA || this.hashTable.readUInt32LE(o + 4) !== wantB) continue;
			const b = index * 16;
			const flags = this.blockTable.readUInt32LE(b + 12);
			if (!(flags & Flags.Exists)) return null;
			return {
				offset: this.blockTable.readUInt32LE(b),
				compressedSize: this.blockTable.readUInt32LE(b + 4),
				size: this.blockTable.readUInt32LE(b + 8),
				flags,
			};
		}
		return null;
	}

	has(name: string): boolean {
		return this.find(name) !== null;
	}

	/** The file's bytes, or null when this archive does not hold it. Throws on an unreadable file. */
	async read(name: string): Promise<Buffer | null> {
		const block = this.find(name);
		if (!block || block.flags & Flags.DeleteMarker) return null;
		const key =
			block.flags & Flags.Encrypted ? fileKey(name, block.offset, block.size, !!(block.flags & Flags.FixKey)) : 0;
		const encrypted = (block.flags & Flags.Encrypted) !== 0;
		const packed = (block.flags & (Flags.Compress | Flags.Implode)) !== 0;

		if (block.size === 0) return Buffer.alloc(0);

		// Only a packed file is split into sectors with a table in front; a stored one is contiguous,
		// and reading a table it never had yields nonsense offsets.
		const imploded = (block.flags & Flags.Implode) !== 0;
		if (block.flags & Flags.SingleUnit || !packed) {
			const raw = await this.slice(block.offset, packed ? block.compressedSize : block.size);
			if (encrypted) decrypt(raw, key);
			return packed ? unpack(raw, block.size, imploded) : raw.subarray(0, block.size);
		}

		const sectors = Math.ceil(block.size / this.sectorSize) || 1;
		// A sector-CRC file appends one more entry, holding the checksum block.
		const entries = sectors + 1 + (block.flags & Flags.SectorCrc ? 1 : 0);
		const table = await this.slice(block.offset, entries * 4);
		if (encrypted) decrypt(table, (key - 1) >>> 0);

		const out = Buffer.alloc(block.size);
		let written = 0;
		for (let i = 0; i < sectors; i++) {
			const from = table.readUInt32LE(i * 4);
			const to = table.readUInt32LE((i + 1) * 4);
			if (to < from || to - from > this.sectorSize * 2) throw new Error(`bad sector table entry ${i} in ${name}`);
			const raw = await this.slice(block.offset + from, to - from);
			if (encrypted) decrypt(raw, (key + i) >>> 0);
			const want = Math.min(this.sectorSize, block.size - written);
			const sector = packed ? unpack(raw, want, imploded) : raw;
			sector.copy(out, written, 0, Math.min(sector.length, want));
			written += want;
		}
		return out;
	}

	/** `offset` is relative to the header, the way the block table states it. */
	private async slice(offset: number, length: number): Promise<Buffer> {
		const buf = Buffer.alloc(length);
		if (length > 0) await this.handle.read(buf, 0, length, this.base + offset);
		return buf;
	}
}

/** One sector or single-unit block. A chunk no smaller than its target was stored as-is. */
function unpack(raw: Buffer, expected: number, imploded: boolean): Buffer {
	if (raw.length >= expected) return raw.subarray(0, expected);
	// An imploded file is PKWARE throughout; only a compressed one names its codec in a leading byte.
	if (imploded) return explode(raw, expected);
	const mask = raw[0];
	const body = raw.subarray(1);
	if (mask === Compression.Zlib) return inflateSync(body);
	if (mask === Compression.Pkware) return explode(body, expected);
	throw new UnsupportedCompression(mask);
}

async function findHeader(handle: FileHandle): Promise<number> {
	const probe = Buffer.alloc(4);
	for (let offset = 0; offset <= HEADER_SEARCH_LIMIT; offset += 512) {
		const { bytesRead } = await handle.read(probe, 0, 4, offset);
		if (bytesRead < 4) break;
		if (probe.toString("latin1") === SIGNATURE) return offset;
	}
	throw new Error("no MPQ header found");
}
