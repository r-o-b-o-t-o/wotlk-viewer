import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { archiveChain } from "./chain.js";
import { MpqArchive, UnsupportedCompression, type MpqFile } from "./Archive.js";

export interface ExtractOptions {
	/** Client install root: the folder holding `Data`. */
	clientDir: string;
	/** Where the extracted tree goes; it ends up holding `Data` and `Data/<locale>`. */
	outDir: string;
	/** Four-letter locale. Detected from the archives in `Data` when omitted. */
	locale?: string;
	/** How many files to read at once from one archive. */
	concurrency?: number;
	onProgress?: (progress: ExtractProgress) => void;
}

export interface ExtractProgress {
	archive: string;
	/** Position of the archive in the chain, 1-based. */
	index: number;
	total: number;
	written: number;
	bytes: number;
}

export interface ExtractResult {
	locale: string;
	archives: string[];
	written: number;
	bytes: number;
	/** Paths a higher-priority archive already supplied. */
	shadowed: number;
	/** Paths a patch archive deletes, so no archive below it may supply them. */
	deleted: number;
	/** Files left out, keyed by why: one entry per reason with a few example paths. */
	skipped: Map<string, { count: number; examples: string[] }>;
}

const PROGRESS_EVERY = 2000;

/**
 * Extracts a client's archives into `outDir`, mirroring the layout the client reads: base archives
 * land in `Data`, locale ones in `Data/<locale>`.
 *
 * Archives are walked highest priority first and the first archive to claim a path wins, so a file
 * patched late in the client's life replaces the original rather than the other way round. That
 * ordering is the whole point of the tool: an extract built in archive-file order quietly serves
 * pre-patch models, which looks like a renderer bug rather than stale data.
 */
export async function extractClient(options: ExtractOptions): Promise<ExtractResult> {
	const dataDir = join(options.clientDir, "Data");
	const locale = options.locale ?? (await detectLocale(dataDir));
	const chain = await archiveChain(dataDir, locale);
	if (chain.length === 0) throw new Error(`No MPQ archives found in ${dataDir}`);

	const claimed = new Set<string>();
	const madeDirs = new Set<string>();
	const skipped = new Map<string, { count: number; examples: string[] }>();
	const result: ExtractResult = {
		locale,
		archives: chain.map((e) => e.path),
		written: 0,
		bytes: 0,
		shadowed: 0,
		deleted: 0,
		skipped,
	};

	const note = (reason: string, path: string) => {
		const seen = skipped.get(reason) ?? { count: 0, examples: [] };
		seen.count++;
		if (seen.examples.length < 5) seen.examples.push(path);
		skipped.set(reason, seen);
	};

	for (const [index, entry] of chain.entries()) {
		const archive = await MpqArchive.open(entry.path);
		try {
			const files = await archive.listFiles();
			if (files.length === 0) note("no (listfile)", entry.path);
			// Claim every path first: a delete marker must shadow lower archives even though the
			// sibling files around it are still being written.
			const mine: MpqFile[] = [];
			for (const file of files) {
				const key = file.name.replace(/\\/g, "/").toLowerCase();
				if (claimed.has(key)) {
					result.shadowed++;
					continue;
				}
				if (file.name.startsWith("(")) continue; // the archive's own index and attributes
				claimed.add(key);
				if (file.deleted) {
					result.deleted++;
					continue;
				}
				mine.push(file);
			}

			let done = 0;
			await pool(mine, options.concurrency ?? 8, async (file) => {
				const relative = file.name.replace(/\\/g, "/");
				if (!safeRelativePath(relative)) {
					note("unsafe path", file.name);
					return;
				}
				let data: Buffer | null;
				try {
					data = await archive.read(file.name);
				} catch (e) {
					note(e instanceof UnsupportedCompression ? e.message : `read failed: ${describe(e)}`, file.name);
					return;
				}
				if (!data) return;
				const target = join(options.outDir, entry.outDir, ...relative.split("/"));
				const dir = dirname(target);
				if (!madeDirs.has(dir)) {
					await mkdir(dir, { recursive: true });
					madeDirs.add(dir);
				}
				await writeFile(target, data);
				result.written++;
				result.bytes += data.length;
				if (++done % PROGRESS_EVERY === 0) {
					options.onProgress?.({
						archive: entry.path,
						index: index + 1,
						total: chain.length,
						written: result.written,
						bytes: result.bytes,
					});
				}
			});
			options.onProgress?.({
				archive: entry.path,
				index: index + 1,
				total: chain.length,
				written: result.written,
				bytes: result.bytes,
			});
		} finally {
			await archive.close();
		}
	}
	return result;
}

/** The locale whose archives sit in `Data/<locale>`; the first one found, alphabetically. */
export async function detectLocale(dataDir: string): Promise<string> {
	const names = await readdir(dataDir).catch(() => []);
	for (const name of names.filter((n) => /^[a-z]{4}$/i.test(n)).sort()) {
		const inside = await readdir(join(dataDir, name)).catch(() => []);
		if (inside.some((n) => n.toLowerCase() === `locale-${name.toLowerCase()}.mpq`)) return name;
	}
	throw new Error(`No locale directory with a locale-<locale>.MPQ found in ${dataDir}`);
}

/** Keeps an archive path inside the output tree: no absolute paths, no climbing out. */
function safeRelativePath(relative: string): boolean {
	if (relative.length === 0 || relative.startsWith("/") || /^[a-z]:/i.test(relative)) return false;
	return !relative.split("/").some((part) => part === ".." || part === "." || part === "");
}

/** Runs `task` over `items` with at most `limit` in flight. */
async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) await task(items[next++]);
	});
	await Promise.all(workers);
}

function describe(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
