import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Resolves client paths (case-insensitive, `\` or `/`) against a list of root directories,
 * first match wins. Directory listings are cached for the process lifetime.
 */
export class FileResolver {
	private readonly dirs = new Map<string, Promise<Map<string, string>>>();

	constructor(readonly roots: string[]) {}

	async resolve(clientPath: string): Promise<string | null> {
		const parts = clientPath.replace(/\\/g, "/").split("/").filter(Boolean);
		if (parts.length === 0 || parts.some((p) => p === "..")) return null;
		for (const root of this.roots) {
			let dir = root;
			let found = true;
			for (const part of parts) {
				const real = (await this.list(dir)).get(part.toLowerCase());
				if (!real) {
					found = false;
					break;
				}
				dir = join(dir, real);
			}
			if (found && (await stat(dir).catch(() => null))?.isFile()) return dir;
		}
		return null;
	}

	private list(dir: string): Promise<Map<string, string>> {
		let p = this.dirs.get(dir);
		if (!p) {
			p = readdir(dir).then(
				(names) => new Map(names.map((n) => [n.toLowerCase(), n])),
				// Forget failures (a missing root, or a transient EMFILE) so they are retried.
				() => {
					this.dirs.delete(dir);
					return new Map<string, string>();
				},
			);
			this.dirs.set(dir, p);
		}
		return p;
	}
}

/** Default search order inside an extracted client: locale folders first, then the base data. */
export async function defaultRoots(clientDir: string): Promise<string[]> {
	const names = await readdir(clientDir);
	const locales = names.filter((n) => /^data_[a-z]{4}$/i.test(n)).sort();
	const base = names.filter((n) => n.toLowerCase() === "data");
	return [...locales, ...base].map((n) => join(clientDir, n));
}
