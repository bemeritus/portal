/**
 * FEEDBACK-5 §3: the section switch sits on the window's centre at every
 * width, and the top bar folds instead of overlapping or cutting anything —
 * search to an icon, unit and theme into one menu, then the brand alone.
 */
import { expect, test, type Page } from "@playwright/test";

import { keepAccountAsFound, LANGS, roomId, setLanguage, setSettings, signIn, THEMES } from "./helpers";

keepAccountAsFound();

type Box = { x: number; y: number; width: number; height: number; what: string; cut: boolean };

/** The bar's visible pieces, their boxes, and whether any text is cut. */
const pieces = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector(".dc-top")!;
    const els = [
      ...bar.querySelectorAll(".dc-top-left > *, .dc-top > nav, .dc-top-right > *"),
    ] as HTMLElement[];
    return els.map((e) => {
      const r = e.getBoundingClientRect();
      const cut = [e, ...e.querySelectorAll("*")].some(
        (x) => x.scrollWidth > x.clientWidth + 1 && getComputedStyle(x).overflow !== "visible",
      );
      return { x: r.x, y: r.y, width: r.width, height: r.height, what: e.className || e.tagName, cut };
    });
  });

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height && b.y < a.y + a.height;

for (const width of [1280, 1440, 1920, 2560]) {
  test(`top bar at ${width} px: centred, nothing overlaps or is cut`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const id = await roomId(page);
    for (const lang of LANGS) {
      await setLanguage(page, lang);
      for (const theme of THEMES) {
        await setSettings(page, { dc_theme: theme });
        await page.goto(`/dc/${id}?view=3d`);
        const nav = page.locator(".dc-top nav");
        await expect(nav.locator('[aria-current="page"]')).toHaveText("3D");
        await page.evaluate(() => document.fonts.ready);
        const box = (await nav.boundingBox())!;
        const at = `${lang} ${theme}`;
        expect(Math.abs(box.x + box.width / 2 - width / 2), at).toBeLessThanOrEqual(1);
        const all = await pieces(page);
        for (const p of all) {
          expect(p.cut, `${at}: ${p.what} is cut`).toBe(false);
          expect(p.x, `${at}: ${p.what}`).toBeGreaterThanOrEqual(0);
          expect(p.x + p.width, `${at}: ${p.what}`).toBeLessThanOrEqual(width);
        }
        for (let i = 0; i < all.length; i++)
          for (let j = i + 1; j < all.length; j++)
            expect(overlap(all[i], all[j]), `${at}: ${all[i].what} × ${all[j].what}`).toBe(false);
      }
    }
  });
}

test("folded, the unit and theme are one «Вид» menu, and search opens ⌘K", async ({ page }) => {
  // Narrower than any target width, so the bar folds at least twice.
  await page.setViewportSize({ width: 1000, height: 900 });
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "drawing", dc_unit: "cm" });
  await page.goto(`/dc/${await roomId(page)}?view=3d`);
  const bar = page.locator(".dc-top");
  await expect(bar).toHaveAttribute("data-fold", /[23]/);
  await bar.getByRole("button", { name: "Найти или сделать…" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar.getByRole("radiogroup")).toHaveCount(0);
  await bar.getByRole("button", { name: "Вид" }).click();
  await page.getByRole("menuitemradio", { name: "мм" }).click();
  await expect.poll(async () => (await (await page.request.get("/api/dc/settings")).json()).dc_unit).toBe("mm");
  await bar.getByRole("button", { name: "Вид" }).click();
  await page.getByRole("menuitemradio", { name: "Студия" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-dc-theme", "studio");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 2560, height: 900 });
  await expect(bar).toHaveAttribute("data-fold", "0");
  await expect(bar.getByRole("radiogroup")).toHaveCount(2);
});
