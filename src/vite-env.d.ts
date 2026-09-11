/// <reference types="vite/client" />

import "vite";
import type { UserConfigExport } from "vite";

declare module "vite" {
	interface ConfigEnv {
		context?: "ui" | "main";
	}

	function defineConfig(
		config: (env: ConfigEnv) => UserConfigExport,
	): UserConfigExport;
}
