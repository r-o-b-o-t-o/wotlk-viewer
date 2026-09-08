import { readFile } from "node:fs/promises";
import { FileNotFoundError, type DataSource } from "@wotlk-viewer/core";
import { defaultRoots, FileResolver } from "./files.js";

/**
 * Reads client files straight from disk; for Node tooling and tests.
 * Kept out of the package entry point, which Vite configs bundle without resolving core's TypeScript.
 */
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
