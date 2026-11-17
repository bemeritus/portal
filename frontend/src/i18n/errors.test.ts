/**
 * Every error sentence the backend can send has a Russian and an Uzbek
 * translation in `errors.ts` — the server writes English (house convention,
 * see `backend/src/error.rs`) and the client translates at display time, so a
 * sentence missing here would reach a Russian reader in English.
 *
 * The backend sources are scanned for the literals handed to `ApiError`
 * variants and to the `db_conflict` / `db_reference` helpers. A `format!`
 * sentence is checked by substituting a sample value for each `{…}` and
 * requiring that one of `PATTERNS` matches it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXACT, PATTERNS, translateApiError } from "./errors";

const BACKEND = join(__dirname, "../../../backend/src");

function rustFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return rustFiles(path);
    return path.endsWith(".rs") ? [path] : [];
  });
}

/** Strip `#[cfg(test)] mod tests { … }` — test fixtures are not messages. */
function withoutTests(src: string): string {
  const i = src.indexOf("#[cfg(test)]");
  return i < 0 ? src : src.slice(0, i);
}

const VARIANT =
  /ApiError::(?:BadRequest|Unauthorized|Forbidden|NotFound|Conflict|PayloadTooLarge|Unprocessable)\(\s*(format!\(\s*)?"((?:[^"\\]|\\.)*)"/g;
const HELPER = /db_(?:conflict|reference)\([^;]*?"((?:[^"\\]|\\.)*)",?\s*\)/g;
/** Messages a module hands to a helper of its own, marked `// error-message`. */
const MARKED = /"((?:[^"\\]|\\.)*)",?\s*\/\/ error-message/g;

function collect() {
  const exact = new Set<string>();
  const formatted = new Set<string>();
  for (const file of rustFiles(BACKEND)) {
    const src = withoutTests(readFileSync(file, "utf8"));
    for (const m of src.matchAll(VARIANT)) (m[1] ? formatted : exact).add(m[2]);
    for (const m of src.matchAll(HELPER)) exact.add(m[1]);
    for (const m of src.matchAll(MARKED)) (m[1].includes("{") ? formatted : exact).add(m[1]);
  }
  return { exact, formatted };
}

const { exact, formatted } = collect();

describe("server error sentences", () => {
  it("finds the backend's messages", () => {
    expect(exact.size).toBeGreaterThan(10);
  });

  it("translates every fixed sentence", () => {
    const missing = [...exact].filter((m) => !(m in EXACT) && !PATTERNS.some((p) => p.re.test(m)));
    expect(missing).toEqual([]);
  });

  it("matches every formatted sentence with a pattern", () => {
    const missing = [...formatted]
      .map((f) => f.replace(/\{[^}]*\}/g, "1"))
      .filter((m) => !PATTERNS.some((p) => p.re.test(m)));
    expect(missing).toEqual([]);
  });

  it("substitutes captured values", () => {
    expect(translateApiError("Password must be at least 6 characters", "ru")).toBe(
      "Пароль должен содержать не менее 6 символов",
    );
    expect(translateApiError("Password must be at least 6 characters", "en")).toBe(
      "Password must be at least 6 characters",
    );
  });
});
