import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CharacterDb, type DbOptions } from "./db.js";
import { defaultRoots, FileResolver } from "./files.js";

export type {
	CharacterDetails,
	CharacterGuild,
	CharacterPet,
	CharacterSummary,
	DbOptions,
	EquippedItem,
} from "./db.js";
export { CharacterDb, FileResolver, defaultRoots };
// FsDataSource lives at `@roboto_/wotlk-viewer-server/fs`; re-exporting it here would drag core's
// TypeScript sources into Vite config bundles, which Node cannot load.

export interface ServerOptions {
	/** Directory holding the extracted MPQ contents (e.g. `.../Extracted`, with `DBFilesClient` under `enUS/`). */
	clientDir: string;
	/** Search roots, in priority order. Defaults to the locale folders followed by `clientDir`. */
	roots?: string[];
	/** URL prefix for client files (default `/data`). */
	dataPrefix?: string;
	/** URL prefix for the character API (default `/api`); disabled when `db` is absent. */
	apiPrefix?: string;
	db?: DbOptions;
}

export type Middleware = (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void;

/**
 * Connect-style middleware serving `GET {dataPrefix}/<client path>` and, with a database,
 * `GET {apiPrefix}/characters?name=<prefix>` and `GET {apiPrefix}/characters/<guid>`.
 */
export async function createMiddleware(opts: ServerOptions): Promise<Middleware> {
	const roots = opts.roots ?? (await defaultRoots(opts.clientDir));
	if (roots.length === 0) throw new Error(`No data folders found in ${opts.clientDir}`);
	const resolver = new FileResolver(roots);
	const dataPrefix = (opts.dataPrefix ?? "/data").replace(/\/$/, "") + "/";
	const apiPrefix = (opts.apiPrefix ?? "/api").replace(/\/$/, "") + "/";
	const db = opts.db ? new CharacterDb(opts.db) : null;

	const json = (res: ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
		res.end(JSON.stringify(body));
	};

	return (req, res, next) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		let path: string;
		try {
			path = decodeURIComponent(url.pathname);
		} catch {
			return json(res, 400, { error: "malformed url" }); // e.g. a dangling percent escape
		}

		if (path.startsWith(dataPrefix)) {
			void (async () => {
				const file = await resolver.resolve(path.slice(dataPrefix.length));
				if (url.searchParams.has("exists")) {
					// Existence probe: 200/204 instead of 404 so browsers do not log an error.
					res.writeHead(file ? 200 : 204, { "Access-Control-Allow-Origin": "*" });
					return res.end();
				}
				if (!file) return json(res, 404, { error: "not found" });
				const { size, mtimeMs } = await stat(file);
				// Revalidate rather than expire: re-extracting the client replaces these files in place,
				// and a stale copy served for hours looks like a renderer bug. The 304 keeps it cheap.
				const etag = `"${mtimeMs.toString(36)}-${size.toString(36)}"`;
				if (req.headers["if-none-match"] === etag) {
					res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
					return res.end();
				}
				res.writeHead(200, {
					"Content-Type": "application/octet-stream",
					"Content-Length": size,
					"Cache-Control": "no-cache",
					ETag: etag,
					"Access-Control-Allow-Origin": "*",
				});
				if (req.method === "HEAD") return res.end();
				// Headers are already sent, so a read error can only be logged; destroy both ends.
				const stream = createReadStream(file);
				stream.on("error", (e) => {
					console.error(`Error streaming ${file}: ${e.message}`);
					res.destroy();
				});
				res.on("close", () => stream.destroy());
				stream.pipe(res);
			})().catch((e) => json(res, 500, { error: String(e) }));
			return;
		}

		if (db && path.startsWith(apiPrefix)) {
			const rest = path.slice(apiPrefix.length);
			void (async () => {
				if (rest === "characters") {
					return json(
						res,
						200,
						await db.search(
							url.searchParams.get("name") ?? "",
							Number(url.searchParams.get("limit") ?? 20),
						),
					);
				}
				const m = /^characters\/(\d+)$/.exec(rest);
				if (m) {
					const c = await db.get(Number(m[1]));
					return c ? json(res, 200, c) : json(res, 404, { error: "not found" });
				}
				json(res, 404, { error: "unknown endpoint" });
			})().catch((e) => json(res, 500, { error: String(e) }));
			return;
		}

		if (next) next();
		else json(res, 404, { error: "not found" });
	};
}

/** Standalone HTTP server (CORS enabled) for non-Vite setups. */
export async function startServer(opts: ServerOptions & { port?: number }): Promise<Server> {
	const middleware = await createMiddleware(opts);
	const server = createServer((req, res) => middleware(req, res));
	const port = opts.port ?? 8090;
	await new Promise<void>((resolve) => server.listen(port, resolve));
	console.log(`wotlk-viewer server listening on http://localhost:${port}`);
	return server;
}
