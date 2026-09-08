import { readFile } from "node:fs/promises";
import type { DataSource } from "@wotlk-viewer/core";
import { defaultRoots, FileResolver } from "./files";

// No runtime import from core: this file is bundled into Vite configs, where core's TS sources cannot be loaded.
class FileNotFoundError extends Error {
	constructor(readonly path: string) {
		super(`File not found: ${path}`);
		this.name = "FileNotFoundError";
	}
}

/** Reads client files straight from disk; for Node tooling and tests. */
export class FsDataSource implements DataSource {
	private readonly resolver: FileResolver;

	constructor(roots: string[]) {
		this.resolver = new FileResolver(roots);
	}

	static async fromClientDir(clientDir: string): Promise<FsDataSource> {
		return new FsDataSource(await defaultRoots(clientDir));
	}

	async readFile(path: string): Promise<ArrayBuffer> {
		const file = await this.resolver.resolve(path);
		if (!file) throw new FileNotFoundError(path);
		const b = await readFile(file);
		return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
	}

	async exists(path: string): Promise<boolean> {
		return (await this.resolver.resolve(path)) !== null;
	}
}
