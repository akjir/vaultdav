import esbuild from "esbuild";

const zeroExternalDependenciesPlugin = {
    name: "zero-external-dependencies",
    setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point") {
                return null;
            }
            if (args.path === "obsidian") {
                return { external: true, path: "obsidian" };
            }
            if (args.path.startsWith("./") || args.path.startsWith("../")) {
                return null;
            }
            return {
                errors: [
                    {
                        text: `External dependency "${args.path}" is prohibited. Only "obsidian" and relative imports within src/ are allowed.`
                    }
                ]
            };
        });
    }
};

async function runBuild() {
    const isProduction = process.argv[2] === "production";
    const context = await esbuild.context({
        bundle: true,
        entryPoints: ["src/main.ts"],
        external: ["obsidian"],
        format: "cjs",
        logLevel: "info",
        minify: isProduction,
        outfile: "main.js",
        platform: "browser",
        plugins: [zeroExternalDependenciesPlugin],
        sourcemap: isProduction ? false : "inline",
        target: "es2022",
        treeShaking: true
    });

    if (isProduction) {
        await context.rebuild();
        await context.dispose();
    } else {
        await context.watch();
    }
}

runBuild();
