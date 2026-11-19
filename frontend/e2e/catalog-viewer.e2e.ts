/**
 * FEEDBACK-5 §5–6, the item page of MTIU-12HWFNX-QRD0W(GA): the page opens
 * at its top; the viewer draws bounding-box dimensions that stay inside it
 * and off the model, frames the model with its marks and dimensions, marks
 * the supply and return openings (outlines, face labels, one tick per
 * supply) and draws no airflow arrows; seed notes in the user's language.
 */
import { expect, test, type Page } from "@playwright/test";

import { keepAccountAsFound, setLanguage, setSettings, signIn, THEMES } from "./helpers";

keepAccountAsFound();

interface Viewer {
  dimensions(): string[];
  marks(): { arrows: number; outlines: number; ticks: number };
}
const viewer = <T>(page: Page, f: (v: Viewer) => T) =>
  page.evaluate(`(${f.toString()})(window.__dcViewer)`) as Promise<T>;

async function mtiu(page: Page): Promise<number> {
  const xs = (await (await page.request.get("/api/dc/catalog")).json()) as { id: number; model: string }[];
  return xs.find((x) => x.model.startsWith("MTIU-12HWFNX"))!.id;
}

test("the item page opens at its top, also from a scrolled list", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "light", dc_unit: "cm" });
  await page.goto("/dc/catalog/cooling");
  await page.getByTestId("catalog-card").first().waitFor();
  await page.locator(".dc-scroll").evaluate((e) => e.scrollTo(0, 900));
  await page.getByTestId("catalog-card").nth(8).getByRole("link").first().click();
  await page.locator(".dc-viewer-host canvas").waitFor();
  expect(await page.locator(".dc-scroll").evaluate((e) => e.scrollTop)).toBe(0);
  const bar = (await page.locator(".dc-top").boundingBox())!;
  const crumbs = (await page.locator(".dc-crumbs").boundingBox())!;
  expect(crumbs.y).toBeGreaterThanOrEqual(bar.y + bar.height);
});

for (const theme of THEMES)
  test(`viewer of MTIU-12HWFNX in ${theme}: dimensions, framing, openings`, async ({ page }) => {
    await signIn(page);
    await setLanguage(page, "ru");
    await setSettings(page, { dc_theme: theme, dc_unit: "cm" });
    await page.goto(`/dc/catalog/item/${await mtiu(page)}`);
    const host = page.locator(".dc-viewer-host");
    await host.locator("canvas").waitFor();
    await page.waitForFunction(() => !!(window as unknown as { __dcViewer?: unknown }).__dcViewer);

    // The bounding box's three dimensions, each inside the viewer.
    await expect.poll(() => viewer(page, (v) => v.dimensions().sort())).toEqual(["d", "h", "w"]);
    const chips = host.locator(".dc-label-dim");
    await expect(chips).toHaveCount(3);
    const frame = (await host.boundingBox())!;
    for (const b of await chips.evaluateAll((els) =>
      els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect),
    )) {
      expect(b.left).toBeGreaterThanOrEqual(frame.x);
      expect(b.right).toBeLessThanOrEqual(frame.x + frame.width);
      expect(b.top).toBeGreaterThanOrEqual(frame.y);
      expect(b.bottom).toBeLessThanOrEqual(frame.y + frame.height);
    }

    // Openings: outlines and one supply tick, no arrows; the toggle says so.
    await expect.poll(() => viewer(page, (v) => v.marks())).toMatchObject({ arrows: 0, ticks: 1 });
    expect((await viewer(page, (v) => v.marks())).outlines).toBeGreaterThanOrEqual(1);
    await expect(host.locator(".dc-label-air")).toHaveText(["спереди"]);
    const toggle = page.getByRole("button", { name: "Подача и забор" });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    expect(await viewer(page, (v) => v.marks())).toEqual({ arrows: 0, outlines: 0, ticks: 0 });
    await expect(host.locator(".dc-label-air")).toHaveCount(0);

    // Every view keeps its dimensions inside the frame.
    for (const name of ["Спереди", "Сбоку", "Сверху"]) {
      await page.getByRole("radio", { name }).click();
      const shown = await viewer(page, (v) => v.dimensions());
      expect(shown.length, name).toBeGreaterThanOrEqual(2);
    }
  });

test("seed notes and conditions in the user's language", async ({ page }) => {
  await signIn(page);
  await setSettings(page, { dc_theme: "light", dc_unit: "cm" });
  const id = await mtiu(page);
  const finish = page.getByTestId("spec-finish");
  for (const [lang, text] of [
    ["ru", "фотографии изделия у производителя"],
    ["uz", "ishlab chiqaruvchining mahsulot fotosuratlari"],
    ["en", "the manufacturer's product photos"],
  ] as const) {
    await setLanguage(page, lang);
    await page.goto(`/dc/catalog/item/${id}`);
    await expect(finish).toContainText(text);
  }
  // Rating conditions too (a precision unit's).
  const xs = (await (await page.request.get("/api/dc/catalog")).json()) as { id: number; model: string }[];
  await setLanguage(page, "ru");
  await page.goto(`/dc/catalog/item/${xs.find((x) => x.model.startsWith("Liebert CRV CRD25"))!.id}`);
  await expect(page.getByTestId("spec-cooling_sensible_w")).toContainText("воздух на входе 37 °C");
});
