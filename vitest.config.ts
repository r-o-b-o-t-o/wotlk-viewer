import { defaultServerConditions, loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Tests read WOW_CLIENT_DIR from .env; loadEnv is Vite's own reader, so no dotenv dependency.
export default defineConfig(({ mode }) => ({
	// Tests run against the workspace sources, not dist.
	ssr: { resolve: { conditions: ["wotlk-source", ...defaultServerConditions] } },
	test: {
		include: ["packages/*/src/**/*.test.ts"],
		env: loadEnv(mode, process.cwd(), "WOW_"),
	},
}));
