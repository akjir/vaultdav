import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            obsidian: new URL("./tests/obsidian_mock.ts", import.meta.url).pathname
        }
    },
    test: {
        environment: "happy-dom",
        include: ["tests/**/*.test.ts"]
    }
});
