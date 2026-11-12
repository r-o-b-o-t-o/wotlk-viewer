#!/usr/bin/env node
import { startServer } from "./index.js";
import { dbOptionsFromUrl } from "./env.js";

// Reads WOW_CLIENT_DIR, WOW_DB_URL and PORT; `npm start -w packages/server` loads them from .env.
const clientDir = process.env.WOW_CLIENT_DIR;
if (!clientDir) {
	console.error("WOW_CLIENT_DIR is not set; point it at an extracted 3.3.5a client");
	process.exit(1);
}

void startServer({
	clientDir,
	db: dbOptionsFromUrl(process.env.WOW_DB_URL),
	port: Number(process.env.PORT ?? 8090),
});
