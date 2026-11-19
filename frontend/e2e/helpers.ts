/**
 * Shared by the end-to-end checks: signing in, the seeded room, and the
 * account's language and module settings — set through the API, and put
 * back as they were after each file (`keepAccountAsFound`).
 */
import { test, type Page } from "@playwright/test";

export type Vec3 = [number, number, number];
export type Lang = "ru" | "uz" | "en";
export type Theme = "studio" | "drawing" | "light";
export const THEMES: Theme[] = ["studio", "drawing", "light"];
export const LANGS: Lang[] = ["ru", "uz", "en"];

export async function signIn(page: Page) {
  await page.goto("/login");
  await page.locator("input").first().fill(process.env.E2E_USER ?? "dcedit");
  await page.locator("input[type=password]").fill(process.env.E2E_PASSWORD ?? "testpass1");
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

export async function roomId(page: Page): Promise<number> {
  const rooms = (await (await page.request.get("/api/dc/rooms")).json()) as { id: number }[];
  return rooms[0].id;
}

async function csrf(page: Page): Promise<string> {
  return ((await (await page.request.get("/api/dc/csrf")).json()) as { token: string }).token;
}

interface Settings {
  dc_theme: Theme | null;
  dc_unit: "mm" | "cm" | "m";
  dc_legend_collapsed: boolean;
  dc_mode: "schema" | "realistic" | "fill" | "power" | null;
}

export async function setSettings(page: Page, s: Partial<Settings>) {
  const r = await page.request.put("/api/dc/settings", {
    data: s,
    headers: { "X-CSRF-Token": await csrf(page) },
  });
  if (!r.ok()) throw new Error(`settings: ${r.status()}`);
}

export async function setLanguage(page: Page, language: Lang) {
  const r = await page.request.put("/api/auth/me/language", { data: { language } });
  if (!r.ok()) throw new Error(`language: ${r.status()}`);
}

/** Restore the account's language, theme and unit after the file's tests. */
export function keepAccountAsFound() {
  let saved: { language: Lang; settings: Settings } | null = null;
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await signIn(page);
    const me = (await (await page.request.get("/api/auth/me")).json()) as { language: Lang };
    const settings = (await (await page.request.get("/api/dc/settings")).json()) as Settings;
    saved = { language: me.language, settings };
    await page.close();
  });
  test.afterAll(async ({ browser }) => {
    if (!saved) return;
    const page = await browser.newPage();
    await signIn(page);
    await setLanguage(page, saved.language);
    await setSettings(page, saved.settings);
    await page.close();
  });
}

interface Engine {
  boxNamed(name: string): { min: Vec3; max: Vec3 } | null;
  project(p: Vec3): [number, number];
  preset(p: string, d: number): void;
  view(): { position: Vec3; target: Vec3; fov: number; ortho: boolean };
  blockedMarks(): { shelfId: number; cellNo: number; shown: boolean; centre: Vec3 }[];
}

/** The page's 3D engine (exposed in development builds). */
export function engine<T>(page: Page, f: (e: Engine) => T): Promise<T> {
  return page.evaluate(
    `(${f.toString()})(window.__dcEngine)`,
  ) as Promise<T>;
}

export async function waitForRoom(page: Page) {
  await page.waitForFunction(() => {
    const e = (window as unknown as { __dcEngine?: Engine }).__dcEngine;
    return !!e?.boxNamed("Стойка 1");
  });
}

/** Move to / click a world point (mm) in the 3D view. */
export async function pointAt(page: Page, p: Vec3, click = true) {
  const [x, y] = await page.evaluate(
    (q) => (window as unknown as { __dcEngine: Engine }).__dcEngine.project(q),
    p,
  );
  const box = (await page.locator(".dc-viewport canvas").first().boundingBox())!;
  await page.mouse.move(box.x + x, box.y + y);
  if (click) await page.mouse.click(box.x + x, box.y + y);
}

/** Apply a change set to the room on top of its current revision. */
export async function change(page: Page, room: number, ops: unknown[]) {
  const { revision } = (await (await page.request.get(`/api/dc/rooms/${room}/revision`)).json()) as {
    revision: number;
  };
  const r = await page.request.post(`/api/dc/rooms/${room}/changes`, {
    data: { base_revision: revision, ops },
    headers: { "X-CSRF-Token": await csrf(page) },
  });
  if (!r.ok()) throw new Error(`changes: ${r.status()} ${await r.text()}`);
}
