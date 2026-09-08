import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
// Relative imports so Vite bundles the TypeScript sources into the config.
import { createMiddleware } from "../../packages/server/src/index.js";
import { dbOptionsFromUrl } from "../../packages/server/src/env.js";

const CLIENT_DIR = process.env.WOW_CLIENT_DIR ?? "C:/Games/WoW/WoW_335a_Clean/Extracted";
const DB_URL = process.env.WOW_DB_URL ?? "mysql://root:root@localhost:3306/acore_characters";

/** Serves the extracted client and the character API from the Vite dev server. */
function wotlkData(): Plugin {
	return {
		name: "wotlk-data",
		async configureServer(server) {
			server.middlewares.use(await createMiddleware({ clientDir: CLIENT_DIR, db: dbOptionsFromUrl(DB_URL) }));
		},
	};
}

export default defineConfig({
	plugins: [solid(), wotlkData()],
	server: { port: 5173 },
});
