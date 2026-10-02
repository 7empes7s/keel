// Builds the UI harness: the portal's real client components rendered with fixture
// data into one self-contained HTML file (ui-harness/dist/index.html). It needs no
// database, no Cloudflare Access and no network: fonts are inlined from the
// @fontsource packages so screenshots render the same on every machine.
//
//   node ui-harness/build.mjs            # for tests and local viewing
//   node ui-harness/build.mjs --fragment # body-only output for hosting as a page
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fragment = process.argv.includes("--fragment");

const result = await build({
  entryPoints: [join(root, "ui-harness/app.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  minify: true,
  jsx: "automatic",
  target: "es2020",
  tsconfig: join(root, "tsconfig.json"),
  alias: {
    "next/navigation": join(root, "ui-harness/shims/navigation.tsx"),
    "next/link": join(root, "ui-harness/shims/link.tsx"),
  },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
const js = result.outputFiles[0].text.replaceAll("</script", "<\\/script");

function fontFace(family, file, weight) {
  const data = readFileSync(join(root, "node_modules", file)).toString("base64");
  return `@font-face{font-family:"${family}";font-style:normal;font-display:block;font-weight:${weight};src:url(data:font/woff2;base64,${data}) format("woff2")}`;
}
const fonts = [
  fontFace("Public Sans Variable", "@fontsource-variable/public-sans/files/public-sans-latin-wght-normal.woff2", "100 900"),
  fontFace("JetBrains Mono", "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2", "400"),
].join("\n");

const css = readFileSync(join(root, "app/globals.css"), "utf8");
const harnessCss = `
.preview-bar{position:fixed;z-index:60;bottom:calc(12px + env(safe-area-inset-bottom, 0px));left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center;padding:4px 4px 4px 10px;border:1px solid var(--line);background:color-mix(in oklab,var(--surface) 92%,transparent);backdrop-filter:blur(6px);font-family:var(--font-mono);font-size:.6875rem;color:var(--text-muted)}
html[data-harness-ci] .preview-bar{display:none}`;

const body = `<title>KEEL Portal Preview</title>
<style>${fonts}
${css}
${harnessCss}</style>
<div id="root"></div>
<script>${js}</script>`;

const html = fragment
  ? body
  : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${body.replace("<div id=\"root\"></div>", "</head><body><div id=\"root\"></div>")}</body></html>`;

const out = join(root, "ui-harness/dist", fragment ? "fragment.html" : "index.html");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`wrote ${out} (${Math.round(html.length / 1024)} KiB)`);
