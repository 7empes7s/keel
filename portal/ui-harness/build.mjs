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
    "@/lib/url-history": join(root, "ui-harness/shims/url-history.ts"),
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
  fontFace("IBM Plex Sans Variable", "@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2", "100 700"),
  fontFace("IBM Plex Mono", "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", "400"),
  fontFace("IBM Plex Mono", "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2", "600"),
].join("\n");

const css = readFileSync(join(root, "app/globals.css"), "utf8");
const harnessCss = `
.preview-bar{position:fixed;z-index:60;right:calc(12px + env(safe-area-inset-right, 0px));bottom:calc(12px + env(safe-area-inset-bottom, 0px));display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.preview-menu{display:flex;flex-direction:column;align-items:stretch;gap:6px;padding:6px;border:1px solid var(--line);background:var(--surface);box-shadow:var(--shadow-overlay)}
.preview-menu[hidden]{display:none}
.preview-toggle{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:2.75rem;min-height:2.75rem;padding:0 14px;border:1px solid var(--line-strong);border-radius:999px;background:var(--surface-raised);color:var(--text);box-shadow:var(--shadow-raised);font-family:var(--font-mono);font-size:.75rem;cursor:pointer}
.preview-toggle .icon{width:1.125rem;height:1.125rem}
@media (max-width:61.99rem){.preview-bar{bottom:calc(3.5rem + 13px + env(safe-area-inset-bottom, 0px))}.preview-toggle{width:2.75rem;padding:0}.preview-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}}
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
