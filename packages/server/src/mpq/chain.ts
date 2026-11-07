import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * One archive in the client's search chain, and the directory its contents belong in. Locale
 * archives live in `Data/<locale>/` and address their files from there, so their contents are
 * written back under a folder of that locale's name.
 */
export interface ChainEntry {
	path: string;
	/** Output subdirectory relative to the extract root: empty for a base archive, the locale for a locale one. */
	outDir: string;
}

/**
 * Base archives in the client's own order (`s_archives` in `Client.cpp`), highest priority first.
 * `****` stands in for the locale, as it does there. Most of these are 1.x-era names that a WotLK
 * install no longer ships; the missing ones are simply skipped.
 */
const BASE_ARCHIVES = [
	"interface.MPQ",
	"misc.MPQ",
	"model.MPQ",
	"texture.MPQ",
	"terrain.MPQ",
	"wmo.MPQ",
	"sound.MPQ",
	"fonts.MPQ",
	"dbc.MPQ",
	"speech.MPQ",
	"expansionloc.MPQ",
	"lichkingloc.MPQ",
	"expansionspeech.MPQ",
	"lichkingspeech.MPQ",
	"expansion.MPQ",
	"lichking.MPQ",
	"common.MPQ",
	"common-2.MPQ",
	"****/locale-****.MPQ",
	"****/speech-****.MPQ",
	"****/expansion-locale-****.MPQ",
	"****/lichking-locale-****.MPQ",
	"****/expansion-speech-****.MPQ",
	"****/lichking-speech-****.MPQ",
	"development.MPQ",
];

/**
 * The patches `PatchFiles` appends after the wildcard pass. Its table holds eight more specs, for
 * `patch-3`, `patch-4` and a `..\Data\` beside the install, but they carry the other value of the
 * flag the client never passes (`PatchFiles patches(locale, false)` in `OpenArchives`), and the
 * numbered ones are covered by the wildcard pass anyway.
 */
const FIXED_PATCHES = ["patch.MPQ", "****/patch-****.MPQ"];

/** Wildcard patch archives: one character, so `patch-2`, `patch-3` and custom `patch-A`.. all match. */
const WILDCARD_BASE = /^patch-.\.mpq$/i;
const wildcardLocale = (locale: string) => new RegExp(`^patch-${locale}-.\\.mpq$`, "i");

/**
 * Every archive the client would load from `dataDir`, highest priority first.
 *
 * The order follows `OpenArchives`: `alternate.MPQ` is opened last of all and so outranks everything,
 * then the patch archives (the list is opened back to front with rising priority, so its own order is
 * already highest-first), then the base archives counting down from the top of the table.
 */
export async function archiveChain(dataDir: string, locale: string): Promise<ChainEntry[]> {
	const localeDir = join(dataDir, locale);
	const inRoot = await listArchives(dataDir);
	const inLocale = await listArchives(localeDir);

	// Pass one of PatchFiles: both wildcard patterns, then sorted descending as one list.
	const inLocaleWildcard = wildcardLocale(locale);
	const wildcard = [
		...inRoot.filter((n) => WILDCARD_BASE.test(n)).map((n) => entry(dataDir, n, null)),
		...inLocale.filter((n) => inLocaleWildcard.test(n)).map((n) => entry(localeDir, n, locale)),
	].sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));

	const fixed = FIXED_PATCHES.map((name) => resolve(dataDir, localeDir, locale, name));
	const alternate = resolve(dataDir, localeDir, locale, "alternate.MPQ");
	const base = BASE_ARCHIVES.map((name) => resolve(dataDir, localeDir, locale, name));

	return dedupe([alternate, ...wildcard, ...fixed, ...base]).filter((e) => exists(e, inRoot, inLocale));
}

interface Candidate extends ChainEntry {
	sortKey: string;
	fileName: string;
	inLocaleDir: boolean;
}

/** `locale` is the locale folder the archive sits in, or null for one directly under `Data`. */
function entry(dir: string, fileName: string, locale: string | null): Candidate {
	// The client sorts the path it built under Data, locale folder included, so the key carries it
	// too — it decides patch precedence and must not follow the output layout.
	const clientPath = locale === null ? `Data/${fileName}` : `Data/${locale}/${fileName}`;
	return {
		path: join(dir, fileName),
		outDir: locale ?? "",
		fileName,
		inLocaleDir: locale !== null,
		sortKey: clientPath.toUpperCase(),
	};
}

function resolve(dataDir: string, localeDir: string, locale: string, template: string): Candidate {
	const name = template.replace(/\*\*\*\*/g, locale);
	const slash = name.indexOf("/");
	return slash < 0 ? entry(dataDir, name, null) : entry(localeDir, name.slice(slash + 1), locale);
}

function dedupe(entries: Candidate[]): Candidate[] {
	const seen = new Set<string>();
	return entries.filter((e) => {
		const key = e.path.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function exists(e: Candidate, inRoot: string[], inLocale: string[]): boolean {
	const pool = e.inLocaleDir ? inLocale : inRoot;
	return pool.some((n) => n.toLowerCase() === e.fileName.toLowerCase());
}

async function listArchives(dir: string): Promise<string[]> {
	return (await readdir(dir).catch(() => [])).filter((n) => n.toLowerCase().endsWith(".mpq"));
}
