import type { Texture } from "three";
import { isFileNotFound, normalizePath, type DataSource } from "./data/DataSource";
import { Dbc } from "./formats/dbc";
import { parseBlp, type BlpImage } from "./formats/blp";
import { parseM2 } from "./formats/m2";
import { parseSkin } from "./formats/skin";
import { M2Model } from "./render/M2Model";
import { blpToTexture, createWhiteTexture } from "./render/textures";

/** Loads and caches game files, parsed models, textures and DBC tables. */
export class AssetManager {
	private readonly files = new Map<string, Promise<ArrayBuffer>>();
	private readonly exists = new Map<string, Promise<boolean>>();
	private readonly models = new Map<string, Promise<M2Model>>();
	private readonly blps = new Map<string, Promise<BlpImage>>();
	private readonly textures = new Map<string, Promise<Texture>>();
	private readonly dbcs = new Map<string, Promise<Dbc>>();
	private white: Texture | null = null;

	constructor(readonly source: DataSource) {}

	/** Placeholder texture used while loading or when a file is missing. */
	get whiteTexture(): Texture {
		return (this.white ??= createWhiteTexture());
	}

	readFile(path: string): Promise<ArrayBuffer> {
		const key = normalizePath(path);
		let p = this.files.get(key);
		if (!p) {
			p = this.source.readFile(key);
			this.files.set(key, p);
			p.catch(() => this.files.delete(key));
		}
		return p;
	}

	/** Like `readFile` but resolves to null for missing files. */
	async tryReadFile(path: string): Promise<ArrayBuffer | null> {
		try {
			return await this.readFile(path);
		} catch (e) {
			if (isFileNotFound(e)) return null;
			throw e;
		}
	}

	fileExists(path: string): Promise<boolean> {
		const key = normalizePath(path);
		let p = this.exists.get(key);
		if (!p) {
			p = this.files.has(key)
				? Promise.resolve(true)
				: this.source.exists
					? this.source.exists(key)
					: this.tryReadFile(key).then((b) => b !== null);
			this.exists.set(key, p);
			p.catch(() => this.exists.delete(key));
		}
		return p;
	}

	/** Loads an M2 model (accepts .m2/.mdx/.mdl paths) with its first skin profile. */
	loadModel(path: string): Promise<M2Model> {
		const key = normalizePath(path).replace(/\.(mdx|mdl)$/, ".m2");
		let p = this.models.get(key);
		if (!p) {
			p = (async () => {
				const [m2Buf, skinBuf] = await Promise.all([
					this.readFile(key),
					this.readFile(key.replace(/\.m2$/, "00.skin")),
				]);
				return new M2Model(key, parseM2(m2Buf), parseSkin(skinBuf));
			})();
			this.models.set(key, p);
			p.catch(() => this.models.delete(key));
		}
		return p;
	}

	/** Loads the external .anim data of a sequence, if any. Resolves once the model can play it. */
	async loadSequence(model: M2Model, seq: number): Promise<void> {
		seq = model.resolveAlias(seq);
		if (model.isSequenceLoaded(seq)) return;
		const path = model.animFilePath(seq);
		if (!path) return;
		if (!(await this.fileExists(path))) return console.warn(`Missing animation file ${path}`);
		model.setSequenceData(seq, await this.readFile(path));
	}

	loadBlp(path: string): Promise<BlpImage> {
		const key = normalizePath(path);
		let p = this.blps.get(key);
		if (!p) {
			p = this.readFile(key).then(parseBlp);
			this.blps.set(key, p);
			p.catch(() => this.blps.delete(key));
		}
		return p;
	}

	/** Loads a BLP as a GPU texture. Missing files yield the white placeholder with a warning. */
	loadTexture(path: string, wrapFlags = 0): Promise<Texture> {
		const key = `${normalizePath(path)}|${wrapFlags}`;
		let p = this.textures.get(key);
		if (!p) {
			p = this.loadBlp(path).then(
				(img) => blpToTexture(img, { wrapFlags }),
				(e) => {
					console.warn(`Failed to load texture ${path}: ${e instanceof Error ? e.message : e}`);
					return this.whiteTexture;
				},
			);
			this.textures.set(key, p);
		}
		return p;
	}

	/** Loads a DBC table by name (e.g. "ChrRaces") from DBFilesClient. */
	loadDbc(name: string): Promise<Dbc> {
		let p = this.dbcs.get(name);
		if (!p) {
			p = this.readFile(`DBFilesClient/${name}.dbc`).then((b) => new Dbc(b));
			this.dbcs.set(name, p);
			p.catch(() => this.dbcs.delete(name));
		}
		return p;
	}
}
