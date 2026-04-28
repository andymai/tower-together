import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";

export default defineConfig({
	plugins: [react(), wasm(), topLevelAwait()],
	optimizeDeps: {
		// elevator-core-wasm ships pre-built ESM + .wasm; Vite's optimizer
		// shouldn't try to re-bundle them.
		exclude: ["@tower-together/elevator-core-wasm"],
	},
	server: {
		port: 5173,
		proxy: {
			"/api": {
				target: "http://localhost:8787",
				changeOrigin: true,
				ws: true,
			},
		},
	},
});
