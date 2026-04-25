import { rm, mkdir, copyFile, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

const watchMode = process.argv.includes("--watch");

const ENTRYPOINTS = [
  "src/background.ts",
  "src/content.ts",
  "src/inject.ts",
  "src/popup/popup.ts",
  "src/options/options.ts",
];

const STATIC_COPIES: Array<[string, string]> = [
  ["manifest.json", "dist/manifest.json"],
  ["src/popup/popup.html", "dist/popup.html"],
  ["src/popup/popup.css", "dist/popup.css"],
  ["src/options/options.html", "dist/options.html"],
  ["src/options/options.css", "dist/options.css"],
];

async function copyIfExists(src: string, dst: string) {
  if (!existsSync(src)) return;
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(src, dst);
}

async function buildOnce() {
  await rm("dist", { recursive: true, force: true });
  await mkdir("dist", { recursive: true });

  const result = await Bun.build({
    entrypoints: ENTRYPOINTS.filter(p => existsSync(p)),
    outdir: "dist",
    target: "browser",
    format: "esm",
    splitting: false,
    minify: false,
    sourcemap: "linked",
    naming: {
      entry: "[name].[ext]",
    },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Build failed");
  }

  for (const [src, dst] of STATIC_COPIES) {
    await copyIfExists(src, dst);
  }

  console.log(`Built ${result.outputs.length} entrypoints to dist/`);
}

if (watchMode) {
  await buildOnce();
  console.log("Watching src/ and manifest.json for changes...");
  const { watch } = await import("node:fs");
  let timer: Timer | null = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      buildOnce().catch(err => console.error(err));
    }, 100);
  };
  watch("src", { recursive: true }, trigger);
  watch("manifest.json", trigger);
} else {
  await buildOnce();
}
