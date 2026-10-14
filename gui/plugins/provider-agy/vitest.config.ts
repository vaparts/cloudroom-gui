import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    testTimeout: 30_000,
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "bb-plugin-provider-agy",
      include: ["*.test.ts", "src/**/*.test.ts"],
    }),
  },
});
