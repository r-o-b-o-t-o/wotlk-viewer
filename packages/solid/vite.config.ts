import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";

// Compiles the JSX for consumers without the Solid plugin; tsc emits the types and the `solid` build.
export default defineConfig({
	plugins: [solid()],
	build: {
		lib: { entry: "src/index.tsx", formats: ["es"], fileName: "index" },
		emptyOutDir: false,
		sourcemap: true,
		rolldownOptions: { external: (id) => !id.startsWith(".") && !id.startsWith("/") && !/^[A-Za-z]:/.test(id) },
	},
});
