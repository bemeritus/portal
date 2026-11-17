/**
 * Every language has every key — the CI check behind "no missing keys".
 *
 * English is the source (and what `t()` is typed against). Russian and Uzbek
 * must carry the same keys, modulo CLDR plural suffixes: Russian has
 * `_one/_few/_many/_other` where English has `_one/_other`, and Uzbek needs
 * only `_other`. Interpolations must match too, or a translation silently drops
 * a number.
 */
import { describe, expect, it } from "vitest";

import { en } from "./locales/en";
import { ru } from "./locales/ru";
import { uz } from "./locales/uz";

const PLURAL = /_(zero|one|two|few|many|other)$/;

type Tree = { [key: string]: string | Tree };

/** `{ "a.b": "text" }` for every leaf, with plural suffixes folded together. */
function flatten(tree: Tree, prefix = "", out = new Map<string, Set<string>>()) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      const base = path.replace(PLURAL, "");
      const vars = out.get(base) ?? new Set<string>();
      for (const m of value.matchAll(/\{\{\s*(\w+)/g)) vars.add(m[1]);
      out.set(base, vars);
    } else {
      flatten(value, path, out);
    }
  }
  return out;
}

const source = flatten(en.translation);

describe.each([
  ["ru", ru.translation],
  ["uz", uz.translation],
])("locale %s", (_name, catalog) => {
  const target = flatten(catalog as Tree);

  it("has every English key", () => {
    const missing = [...source.keys()].filter((k) => !target.has(k));
    expect(missing).toEqual([]);
  });

  it("has no keys English lacks", () => {
    const extra = [...target.keys()].filter((k) => !source.has(k));
    expect(extra).toEqual([]);
  });

  it("uses the same interpolations", () => {
    const differing = [...source.entries()]
      .filter(([k]) => target.has(k))
      .filter(([k, vars]) => {
        const other = target.get(k)!;
        return [...vars].some((v) => !other.has(v) && v !== "count");
      })
      .map(([k]) => k);
    expect(differing).toEqual([]);
  });
});

function leaves(tree: Tree, prefix = ""): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [[path, value] as [string, string]] : leaves(value, path);
  });
}

it("Uzbek is Latin script only", () => {
  const cyrillic = leaves(uz.translation as Tree)
    .filter(([, text]) => /[\u0400-\u04FF]/.test(text))
    .map(([path]) => path);
  expect(cyrillic).toEqual([]);
});
