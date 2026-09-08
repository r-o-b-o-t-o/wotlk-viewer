import type { BinaryReader } from "../io/BinaryReader.js";
import type { M2Track } from "../formats/m2.js";

export type TrackKind = "vec3" | "quat" | "compquat" | "fixed16" | "float" | "u8" | "u16";

/** Decoded keyframes of one track for one sequence. */
export interface TrackKeys {
	times: Uint32Array;
	/** `comp` floats per value; hermite/bezier tracks store 3 values (value, in, out) per key. */
	values: Float32Array;
	comp: number;
	interpolation: number;
}

const COMPONENTS: Record<TrackKind, number> = {
	vec3: 3,
	quat: 4,
	compquat: 4,
	fixed16: 1,
	float: 1,
	u8: 1,
	u16: 1,
};

/** Reads and converts the keys of `track` for sequence `seq` from `r`. Null when the track has no data. */
export function readTrackKeys(r: BinaryReader, track: M2Track, seq: number, kind: TrackKind): TrackKeys | null {
	const ts = track.timestamps[seq];
	const vs = track.values[seq];
	if (!ts || !vs || ts.count === 0 || vs.count === 0) return null;
	const comp = COMPONENTS[kind];
	const n = vs.count * comp;
	let values: Float32Array;
	switch (kind) {
		case "vec3":
		case "quat":
		case "float":
			values = r.f32ArrayAt(vs.offset, n);
			break;
		case "compquat":
			values = new Float32Array(n);
			for (let i = 0; i < n; i++) {
				const v = r.i16At(vs.offset + i * 2);
				values[i] = (v > 0 ? v - 32767 : v + 32767) / 32767;
			}
			break;
		case "fixed16":
			values = new Float32Array(n);
			for (let i = 0; i < n; i++) values[i] = r.i16At(vs.offset + i * 2) / 32767;
			break;
		case "u8":
			values = new Float32Array(n);
			for (let i = 0; i < n; i++) values[i] = r.u8At(vs.offset + i);
			break;
		case "u16":
			values = new Float32Array(n);
			for (let i = 0; i < n; i++) values[i] = r.u16At(vs.offset + i * 2);
			break;
	}
	return { times: r.u32ArrayAt(ts.offset, ts.count), values, comp, interpolation: track.interpolation };
}

/** Writes the interpolated value at `time` (ms) into `out`. */
export function sampleTrack(keys: TrackKeys, time: number, out: Float32Array, isQuat = false): void {
	const { times, values, comp, interpolation } = keys;
	const n = times.length;
	const stride = interpolation >= 2 ? comp * 3 : comp;
	if (n === 1 || time <= times[0]) return copy(values, 0, out, comp);
	if (time >= times[n - 1]) return copy(values, (n - 1) * stride, out, comp);

	// Binary search for the key interval.
	let lo = 0,
		hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (times[mid] <= time) lo = mid;
		else hi = mid;
	}
	if (interpolation === 0) return copy(values, lo * stride, out, comp);

	const t = (time - times[lo]) / (times[hi] - times[lo]);
	const a = lo * stride,
		b = hi * stride;
	if (interpolation === 1 || isQuat) {
		if (isQuat) return nlerpQuat(values, a, b, t, out);
		for (let i = 0; i < comp; i++) out[i] = values[a + i] + (values[b + i] - values[a + i]) * t;
		return;
	}
	// Hermite (bezier is treated the same; rare in WotLK data).
	const t2 = t * t,
		t3 = t2 * t;
	const h1 = 2 * t3 - 3 * t2 + 1,
		h2 = -2 * t3 + 3 * t2,
		h3 = t3 - 2 * t2 + t,
		h4 = t3 - t2;
	for (let i = 0; i < comp; i++) {
		out[i] = h1 * values[a + i] + h2 * values[b + i] + h3 * values[a + comp * 2 + i] + h4 * values[b + comp + i];
	}
}

function copy(src: Float32Array, o: number, out: Float32Array, comp: number): void {
	for (let i = 0; i < comp; i++) out[i] = src[o + i];
}

function nlerpQuat(v: Float32Array, a: number, b: number, t: number, out: Float32Array): void {
	let dot = 0;
	for (let i = 0; i < 4; i++) dot += v[a + i] * v[b + i];
	const s = dot < 0 ? -1 : 1;
	let len = 0;
	for (let i = 0; i < 4; i++) {
		out[i] = v[a + i] * (1 - t) + v[b + i] * t * s;
		len += out[i] * out[i];
	}
	len = Math.sqrt(len) || 1;
	for (let i = 0; i < 4; i++) out[i] /= len;
}
