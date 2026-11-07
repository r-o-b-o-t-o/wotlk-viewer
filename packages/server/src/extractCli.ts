import { rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { extractClient } from "./mpq/extractClient.js";

// Extracts a client's MPQ archives in the order the client reads them. Reads WOW_CLIENT_DIR;
// `npm run extract -w packages/server` loads it from .env.
const USAGE = `Usage: extract-client [options]

  --client <dir>   Client install holding Data/ (default: the parent of WOW_CLIENT_DIR)
  --out <dir>      Where to write Data/ and Data/<locale>/ (default: WOW_CLIENT_DIR)
  --locale <code>  Four-letter locale (default: detected from Data/)
  --clean          Delete the output directory first
  --jobs <n>       Files read at once from one archive (default 8)
`;

function parse(argv: string[]): Map<string, string> {
	const out = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
		const name = arg.slice(2);
		if (name === "clean" || name === "help") out.set(name, "true");
		else {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			out.set(name, value);
		}
	}
	return out;
}

const args = parse(process.argv.slice(2));
if (args.has("help")) {
	console.log(USAGE);
	process.exit(0);
}

const envClient = process.env.WOW_CLIENT_DIR;
const outDir = args.get("out") ?? envClient;
const clientDir = args.get("client") ?? (envClient ? dirname(envClient) : undefined);
if (!outDir || !clientDir) {
	console.error("Set WOW_CLIENT_DIR, or pass --client and --out.\n\n" + USAGE);
	process.exit(1);
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

if (args.has("clean")) {
	const existing = await stat(outDir).catch(() => null);
	if (existing) {
		console.log(`Removing ${resolve(outDir)}`);
		await rm(outDir, { recursive: true, force: true });
	}
}

const started = Date.now();
const result = await extractClient({
	clientDir,
	outDir,
	locale: args.get("locale"),
	concurrency: args.has("jobs") ? Number(args.get("jobs")) : undefined,
	onProgress: (p) =>
		process.stdout.write(`\r[${p.index}/${p.total}] ${p.written} files, ${mb(p.bytes)}${" ".repeat(10)}`),
});

process.stdout.write("\n");
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
