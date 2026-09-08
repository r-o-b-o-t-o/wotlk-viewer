import { startServer } from "./index";
import { dbOptionsFromUrl } from "./env";

// Usage: WOW_CLIENT_DIR=<extracted client> [WOW_DB_URL=mysql://user:pass@host:3306/acore_characters] [PORT=8090]
const clientDir = process.env.WOW_CLIENT_DIR;
if (!clientDir) {
	console.error("WOW_CLIENT_DIR is required");
	process.exit(1);
}

void startServer({
	clientDir,
	db: dbOptionsFromUrl(process.env.WOW_DB_URL),
	port: Number(process.env.PORT ?? 8090),
});
