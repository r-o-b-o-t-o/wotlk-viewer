import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CharacterDb, type DbOptions } from "./db.js";
import { defaultRoots, FileResolver } from "./files.js";

export type { CharacterDetails, CharacterSummary, DbOptions, EquippedItem } from "./db.js";
export { CharacterDb, FileResolver, defaultRoots };
export { FsDataSource } from "./FsDataSource.js";

export interface ServerOptions {
	/** Directory holding the extracted MPQ contents (e.g. `.../Extracted` with `Data` and `Data_enUS` inside). */
	clientDir: string;
	/** Search roots, in priority order. Defaults to locale folders followed by `Data`. */
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
		const path = decodeURIComponent(url.pathname);

		if (path.startsWith(dataPrefix)) {
			void (async () => {
				const file = await resolver.resolve(path.slice(dataPrefix.length));
				if (url.searchParams.has("exists")) {
					// Existence probe: 200/204 instead of 404 so browsers do not log an error.
					res.writeHead(file ? 200 : 204, { "Access-Control-Allow-Origin": "*" });
					return res.end();
				}
				if (!file) return json(res, 404, { error: "not found" });
				const size = (await stat(file)).size;
				res.writeHead(200, {
					"Content-Type": "application/octet-stream",
					"Content-Length": size,
					"Cache-Control": "public, max-age=86400",
					"Access-Control-Allow-Origin": "*",
				});
				if (req.method === "HEAD") return res.end();
				createReadStream(file).pipe(res);
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
