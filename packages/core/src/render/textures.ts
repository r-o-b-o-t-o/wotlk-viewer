import {
	CanvasTexture,
	ClampToEdgeWrapping,
	DataTexture,
	LinearFilter,
	LinearMipmapLinearFilter,
	RepeatWrapping,
	RGBAFormat,
	Texture,
	UnsignedByteType,
} from "three";
import type { BlpImage } from "../formats/blp.js";

export interface TextureOptions {
	/** M2 texture flags: 1 = wrap X, 2 = wrap Y. */
	wrapFlags?: number;
	anisotropy?: number;
}

function applyOptions(tex: Texture, opts: TextureOptions): void {
	const flags = opts.wrapFlags ?? 0;
	tex.wrapS = flags & 1 ? RepeatWrapping : ClampToEdgeWrapping;
	tex.wrapT = flags & 2 ? RepeatWrapping : ClampToEdgeWrapping;
	tex.minFilter = LinearMipmapLinearFilter;
	tex.magFilter = LinearFilter;
	tex.generateMipmaps = true;
	tex.flipY = false;
	tex.anisotropy = opts.anisotropy ?? 4;
	tex.needsUpdate = true;
}

/** Uploads a decoded BLP as a three.js texture. */
export function blpToTexture(img: BlpImage, opts: TextureOptions = {}): DataTexture {
	const tex = new DataTexture(img.data, img.width, img.height, RGBAFormat, UnsignedByteType);
	applyOptions(tex, opts);
	return tex;
}

export function canvasToTexture(
	canvas: HTMLCanvasElement | OffscreenCanvas,
	opts: TextureOptions = {},
): CanvasTexture<HTMLCanvasElement | OffscreenCanvas> {
	const tex = new CanvasTexture(canvas);
	applyOptions(tex, opts);
	return tex;
}

/** 1x1 opaque white placeholder. */
export function createWhiteTexture(): DataTexture {
	const tex = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
	tex.needsUpdate = true;
	return tex;
}
