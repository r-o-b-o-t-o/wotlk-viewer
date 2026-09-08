import type { BlpImage } from "../formats/blp";
import { CHAR_REGIONS, type CharRegion, type Rect } from "./constants";

const imageCanvases = new WeakMap<BlpImage, HTMLCanvasElement>();

/** Wraps a decoded BLP in a canvas so it can be drawn with `drawImage` (cached per image). */
export function blpToCanvas(img: BlpImage): HTMLCanvasElement {
	let c = imageCanvases.get(img);
	if (!c) {
		c = document.createElement("canvas");
		c.width = img.width;
		c.height = img.height;
		const data = new ImageData(
			new Uint8ClampedArray(img.data.buffer as ArrayBuffer, img.data.byteOffset, img.data.byteLength),
			img.width,
			img.height,
		);
		c.getContext("2d")!.putImageData(data, 0, 0);
		imageCanvases.set(img, c);
	}
	return c;
}

/** Layers body-region textures onto a character skin using a 2D canvas. */
export class TextureCompositor {
	readonly canvas: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D;
	/** Scale from the 256-based region layout to the actual texture size. */
	private readonly scale: number;

	constructor(
		readonly width: number,
		readonly height: number,
	) {
		this.canvas = document.createElement("canvas");
		this.canvas.width = width;
		this.canvas.height = height;
		this.ctx = this.canvas.getContext("2d")!;
		this.scale = width / 256;
	}

	/** Draws `img` over the whole texture (region omitted) or into a body region. */
	draw(img: BlpImage, region?: CharRegion): void {
		const r: Rect = region === undefined ? { x: 0, y: 0, w: 256, h: 256 } : CHAR_REGIONS[region];
		const s = this.scale;
		this.ctx.drawImage(blpToCanvas(img), r.x * s, r.y * s, r.w * s, r.h * s);
	}
}
