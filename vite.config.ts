/// <reference path="./src/vite-env.d.ts" />

import { defineConfig } from "vite";

export default defineConfig(({ context }) => ({
	build: context === "ui" ? { chunkSizeWarningLimit: 1000 } : {},
}));
