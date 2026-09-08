import { BinaryReader } from "../io/BinaryReader.js";

/** WDBC table: fixed-size records of 4-byte fields plus a string block. */
export class Dbc {
	readonly recordCount: number;
	readonly fieldCount: number;
	readonly recordSize: number;
	private readonly r: BinaryReader;
	private readonly stringBase: number;

	constructor(buffer: ArrayBuffer) {
		const r = new BinaryReader(buffer);
		if (r.string(4) !== "WDBC") throw new Error("Not a WDBC file");
		this.recordCount = r.u32();
		this.fieldCount = r.u32();
		this.recordSize = r.u32();
		r.u32(); // string block size
		this.r = r;
		this.stringBase = 20 + this.recordCount * this.recordSize;
	}

	private off(record: number, field: number): number {
		return 20 + record * this.recordSize + field * 4;
	}

	uint(record: number, field: number): number {
		return this.r.u32At(this.off(record, field));
	}
	int(record: number, field: number): number {
		return this.r.i32At(this.off(record, field));
	}
	float(record: number, field: number): number {
		return this.r.f32At(this.off(record, field));
	}
	string(record: number, field: number): string {
		return this.r.cstringAt(this.stringBase + this.uint(record, field));
	}

	/** Maps every record through `read`. */
	map<T>(read: (record: number) => T): T[] {
		const out: T[] = new Array(this.recordCount);
		for (let i = 0; i < this.recordCount; i++) out[i] = read(i);
		return out;
	}
}
