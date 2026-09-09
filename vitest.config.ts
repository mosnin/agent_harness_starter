import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "@": path.resolve(__dirname, "./src") };
const ignored = ["**/node_modules/**", "**/dist/**", "**/.next/**"];

/**
 * Two projects rather than one environment, so adding a DOM does not change what the ~760
 * existing node suites run against: a stray `document` there still fails loudly.
 *
 * The split is by file extension, which is also the rule for writing a new test:
 *   *.test.ts   → node        (pure logic, the default)
 *   *.test.tsx  → jsdom       (anything that mounts a component)
 *   *.dom.test.ts → jsdom     (a DOM test with no JSX in it)
 */
export default defineConfig({
	resolve: { alias },
	test: {
		projects: [
			{
				resolve: { alias },
				test: {
					name: "node",
					environment: "node",
					globals: true,
					include: ["**/*.{test,spec}.ts"],
					exclude: [...ignored, "**/*.dom.{test,spec}.ts"],
				},
			},
			{
				resolve: { alias },
				// tsconfig sets `jsx: "preserve"` for Next; the DOM suites need it actually compiled.
				oxc: { jsx: { runtime: "automatic", importSource: "react" } },
				test: {
					name: "dom",
					environment: "jsdom",
					globals: true,
					include: ["**/*.{test,spec}.tsx", "**/*.dom.{test,spec}.ts"],
					exclude: ignored,
				},
			},
		],
	},
});
