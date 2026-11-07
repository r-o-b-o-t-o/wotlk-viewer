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

/** Locale folder names a 3.3.5a client ships. Matched by name because `Item` is four letters too. */
const LOCALES = new Set([
	"enus",
	"engb",
	"encn",
	"entw",
	"frfr",
	"dede",
	"eses",
	"esmx",
	"itit",
	"ptbr",
	"ptpt",
	"ruru",
	"kokr",
	"zhcn",
	"zhtw",
]);

/**
 * Default search order inside an extracted client: its locale folders first, then the root. A locale
 * archive outranks the base ones it overlaps, and the extractor already resolved the rest of the
 * precedence by writing each path once, so these roots are enough.
 */
export async function defaultRoots(clientDir: string): Promise<string[]> {
	const locales = (await readdir(clientDir, { withFileTypes: true }).catch(() => []))
		.filter((e) => e.isDirectory() && LOCALES.has(e.name.toLowerCase()))
		.map((e) => join(clientDir, e.name))
		.sort();
	return [...locales, clientDir];
}
