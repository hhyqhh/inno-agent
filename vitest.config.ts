import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: ["**/node_modules/**", "runtime/**", "workspace/**"],
		setupFiles: ["./vitest.setup.ts"],
		// Component tests (*.test.tsx) render real DOM; pure store/util tests
		// (*.test.ts) stay in the faster node environment.
		projects: [
			{
				extends: true,
				test: {
					name: "node",
					include: ["apps/inno-agent/src/**/*.test.ts", "apps/inno-agent/web/src/**/*.test.ts", "electron/**/*.test.ts"],
					environment: "node",
				},
			},
			{
				extends: true,
				test: {
					name: "web",
					include: ["apps/inno-agent/web/src/**/*.test.tsx"],
					environment: "jsdom",
				},
			},
		],
	},
});
