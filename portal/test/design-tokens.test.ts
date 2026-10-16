// The portal's colours come from the token blocks at the top of app/globals.css
// (direction A, "Chart room"). This keeps them the only colour source and keeps
// both themes readable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing ${selector}`);
  const end = css.indexOf("}", start);
  return css.slice(start, end + 1);
}

function tokens(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) map.set(name, value.trim());
  return map;
}

const darkBlock = block(":root");
const lightMediaBlock = block(':root:not([data-theme="dark"])');
const lightPinnedBlock = block(':root[data-theme="light"]');
const dark = tokens(darkBlock);
const light = new Map([...dark, ...tokens(lightPinnedBlock)]);

function hex(theme: Map<string, string>, name: string, seen = new Set<string>()): string {
  const value = theme.get(name);
  assert.ok(value, `token ${name} is not defined`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  if (alias) {
    assert.ok(!seen.has(name), `token ${name} aliases itself`);
    return hex(theme, alias[1], seen.add(name));
  }
  assert.match(value, /^#[0-9a-f]{6}$/, `${name} should be a 6-digit hex colour`);
  return value;
}

function luminance(value: string): number {
  const n = Number.parseInt(value.slice(1), 16);
  const [r, g, b] = [16, 8, 0].map((shift) => {
    const c = ((n >> shift) & 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("the brand colours match the chosen direction", () => {
  assert.equal(hex(dark, "--navy"), "#1b2a4a");
  assert.equal(hex(light, "--rail"), "#1b2a4a");
  assert.equal(hex(dark, "--accent-fill"), "#f5a623");
  assert.equal(hex(light, "--accent-fill"), "#f5a623");
  assert.equal(hex(dark, "--canvas"), "#0b1322");
  assert.equal(hex(light, "--canvas"), "#f3f5f9");
  assert.match(dark.get("--font-sans") ?? "", /^"IBM Plex Sans Variable"/);
  assert.match(dark.get("--font-mono") ?? "", /^"IBM Plex Mono"/);
});

test("both light blocks are identical", () => {
  const body = (b: string) => b.slice(b.indexOf("{") + 1).replace(/\s+/g, " ").trim();
  assert.equal(body(lightMediaBlock), body(lightPinnedBlock));
});

test("no colour literal outside the token blocks", () => {
  let rest = css;
  for (const b of [darkBlock, lightMediaBlock, lightPinnedBlock]) rest = rest.replace(b, "");
  rest = rest.replace(/\/\*[\s\S]*?\*\//g, "");
  const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(|:\s*(?:white|black)\b|\b(?:white|black)\)/g;
  const found = [...rest.matchAll(literal)].map((m) => {
    const line = rest.slice(0, m.index).split("\n").length;
    return `${m[0]} near "${rest.split("\n")[line - 1].trim()}"`;
  });
  assert.deepEqual(found, []);
});

const TEXT = 4.5;
const NON_TEXT = 3;

for (const [name, theme] of [["dark", dark], ["light", light]] as const) {
  test(`${name} theme: text stays readable on every surface`, () => {
    const surfaces = ["--canvas", "--surface-muted", "--surface", "--surface-raised", "--sidebar"];
    const failures: string[] = [];
    const check = (fg: string, bg: string, min: number) => {
      const ratio = contrast(hex(theme, fg), hex(theme, bg));
      if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
    };
    for (const bg of surfaces) {
      for (const fg of ["--text", "--text-soft", "--text-muted", "--accent", "--urgent", "--check-soon", "--low-risk", "--fine", "--neutral"]) {
        check(fg, bg, TEXT);
      }
      check("--control-border", bg, NON_TEXT);
    }
    for (const tone of ["urgent", "check-soon", "low-risk", "fine", "neutral"]) check(`--${tone}`, `--${tone}-bg`, TEXT);
    check("--accent", "--accent-soft", TEXT);
    check("--on-accent", "--accent-fill", TEXT);
    check("--on-accent", "--accent-fill-hover", TEXT);
    check("--rail-text", "--rail", TEXT);
    check("--rail-soft", "--rail", TEXT);
    assert.deepEqual(failures, []);
  });
}
