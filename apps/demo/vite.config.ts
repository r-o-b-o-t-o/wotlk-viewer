import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import solid from "vite-plugin-solid";
// Relative imports so Vite bundles the TypeScript sources into the config.
import { createMiddleware } from "../../packages/server/src/index.js";
import { dbOptionsFromUrl } from "../../packages/server/src/env.js";

// .env lives at the repo root, one file for every package.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Serves the extracted client and the character API from the Vite dev server. */
function wotlkData(clientDir: string, dbUrl: string | undefined): Plugin {
	return {
		name: "wotlk-data",
		async configureServer(server) {
			server.middlewares.use(await createMiddleware({ clientDir, db: dbOptionsFromUrl(dbUrl) }));
		},
	};
}

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, ROOT, "WOW_");
	if (!env.WOW_CLIENT_DIR) throw new Error("WOW_CLIENT_DIR is not set; copy .env.example to .env");
	return {
		envDir: ROOT,
		plugins: [solid(), wotlkData(env.WOW_CLIENT_DIR, env.WOW_DB_URL || undefined)],
		server: { port: 5173 },
	};
});
