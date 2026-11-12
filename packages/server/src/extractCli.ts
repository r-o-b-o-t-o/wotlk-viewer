#!/usr/bin/env node
import { ArgumentParser } from "argparse";
import { SingleBar } from "cli-progress";
import { rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { extractClient } from "./mpq/extractClient.js";

// Extracts a client's MPQ archives in the order the client reads them. Reads WOW_CLIENT_DIR;
// `npm run extract -w packages/server` loads it from .env.
const envClient = process.env.WOW_CLIENT_DIR;

const parser = new ArgumentParser({
	prog: "extract-client",
	description: "Extract a WoW client's MPQ archives in the order the client reads them.",
});
parser.add_argument("--client", {
	metavar: "<dir>",
	default: envClient && dirname(envClient),
	help: "Client install holding Data/ (default: the parent of WOW_CLIENT_DIR)",
});
parser.add_argument("--out", {
	metavar: "<dir>",
	default: envClient,
	help: "Where to write the extracted tree (default: WOW_CLIENT_DIR)",
});
parser.add_argument("--locale", { metavar: "<code>", help: "Four-letter locale (default: detected from Data/)" });
parser.add_argument("--clean", { action: "store_true", help: "Delete the output directory first" });
parser.add_argument("--jobs", { metavar: "<n>", type: "int", help: "Files read at once from one archive (default 8)" });

interface Args {
	client?: string;
	out?: string;
	locale?: string;
	clean: boolean;
	jobs?: number;
}

const args = parser.parse_args() as Args;

// `parser.error` exits, but argparse does not type it as never.
function required(value: string | undefined): string {
	if (value) return value;
	parser.error("set WOW_CLIENT_DIR, or pass --client and --out");
	process.exit(2);
}

const clientDir = required(args.client);
const outDir = required(args.out);

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

if (args.clean) {
	const existing = await stat(outDir).catch(() => null);
	if (existing) {
		console.log(`Removing ${resolve(outDir)}`);
		await rm(outDir, { recursive: true, force: true });
	}
}

const bar = new SingleBar({
	format: "[{bar}] {value}/{total} archives | {files} files | {size} | {archive}",
	// Block glyphs come out as mojibake in a Windows console that is not on a UTF-8 code page.
	barCompleteChar: "=",
	barIncompleteChar: "-",
	// Progress still shows when the output is a pipe or a terminal that ignores a bare \r.
	noTTYOutput: true,
	notTTYSchedule: 5000,
	hideCursor: true,
});

const started = Date.now();
let running = false;
const result = await extractClient({
	clientDir,
	outDir,
	locale: args.locale,
	concurrency: args.jobs,
	onProgress: (p) => {
		if (!running) {
			bar.start(p.total, 0, { files: 0, size: mb(0), archive: "" });
			running = true;
		}
		bar.update(p.finished ? p.index : Math.max(0, p.index - 1), {
			files: p.written,
			size: mb(p.bytes),
			archive: p.archive === "" ? "" : basename(p.archive),
		});
	},
}).catch((error: unknown) => {
	// A wrong --client is the likely failure here, and a stack trace says nothing about it.
	bar.stop();
	console.error(`\n${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
bar.stop();

console.log(`\nLocale ${result.locale}; archives in priority order:`);
for (const path of result.archives) console.log(`  ${path}`);
console.log(
	`\n${result.written} files, ${mb(result.bytes)} in ${((Date.now() - started) / 1000).toFixed(0)}s` +
		`\n${result.shadowed} shadowed by a higher-priority archive, ${result.deleted} deleted by a patch`,
);
if (result.skipped.size > 0) {
	console.log("\nSkipped:");
	for (const [reason, { count, examples }] of result.skipped) {
		console.log(`  ${count}x ${reason}`);
		for (const example of examples) console.log(`      ${example}`);
	}
}
