/**
 * FEEDBACK-2 §1: the inspector's tabs fit one row at its default width, in
 * every theme and language — the same `top` for every tab button (and «⋯»,
 * when there is one), no horizontal scrolling, the theme's body font size,
 * and every tab still reachable: in the row or the «⋯» menu, and with the
 * arrow keys.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import { keepAccountAsFound, LANGS, roomId, setLanguage, setSettings, signIn, THEMES, waitForRoom } from "./helpers";

keepAccountAsFound();

const TAB_COUNT = 5;

/** Every tab button (and «⋯») on one line inside the control, nothing scrolling. */
async function oneRow(insp: Locator, label: string) {
  const buttons = insp.locator('[role="tablist"] [role="tab"], button.dc-tab-more');
  const boxes = await buttons.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, right: r.right };
    }),
  );
  expect(boxes.length, label).toBeGreaterThan(1);
  for (const b of boxes) expect(b.top, `${label}: one row`).toBeCloseTo(boxes[0].top, 0);
  const row = await insp.locator(".dc-tabs-row").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, scroll: el.scrollWidth, client: el.clientWidth };
  });
  expect(row.scroll, `${label}: no horizontal scroll`).toBeLessThanOrEqual(row.client);
  for (const b of boxes) {
    expect(b.left, `${label}: inside the control`).toBeGreaterThanOrEqual(row.left - 0.5);
    expect(b.right, `${label}: inside the control`).toBeLessThanOrEqual(row.right + 0.5);
  }
}

async function checkRow(page: Page, label: string) {
  const insp = page.locator(".dc-inspector");
  const box = (await insp.boundingBox())!;
  // The default width (360 floating, 340 docked in the drawing theme).
  expect(box.width, label).toBeLessThanOrEqual(361);
  await oneRow(insp, label);

  // The font is the theme's body size, never smaller.
  const sizes = await insp.locator('[role="tab"]').evaluateAll((els) => {
    const body = parseFloat(getComputedStyle(document.querySelector(".dc-root")!).fontSize);
    return els.map((el) => parseFloat(getComputedStyle(el).fontSize) - body);
  });
  for (const d of sizes) expect(d, `${label}: font size`).toBeGreaterThanOrEqual(0);

  // Every tab is in the row or behind «⋯».
  const inRow = await insp.locator('[role="tab"]').count();
  let inMenu = 0;
  if (await insp.locator("button.dc-tab-more").count()) {
    await insp.locator("button.dc-tab-more").click();
    inMenu = await page.getByRole("menuitem").count();
    await page.keyboard.press("Escape");
  }
  expect(inRow + inMenu, label).toBe(TAB_COUNT);

  // Arrow keys go through all five, overflowed ones included; the active
  // tab is always in the row, selected and focused, and the row stays one.
  const tablist = insp.getByRole("tablist");
  await tablist.locator('[aria-selected="true"]').focus();
  const seen = new Set<string>();
  for (let i = 0; i < TAB_COUNT; i++) {
    const active = tablist.locator('[aria-selected="true"]');
    await expect(active, label).toBeFocused();
    seen.add((await active.getAttribute("id")) ?? "");
    await oneRow(insp, `${label}, ${i + 1}. tab`);
    await page.keyboard.press("ArrowRight");
  }
  expect(seen.size, label).toBe(TAB_COUNT);
  await page.keyboard.press("End");
  await expect(tablist.locator('[aria-selected="true"]')).toHaveAttribute("id", "dc-tab-ruler");
  await page.keyboard.press("Home");
  await expect(tablist.locator('[aria-selected="true"]')).toHaveAttribute("id", "dc-tab-object");
}

for (const lang of LANGS)
  test(`inspector tabs fit one row in every theme: ${lang}`, async ({ page }) => {
    await signIn(page);
    await setLanguage(page, lang);
    await setSettings(page, { dc_theme: "studio" });
    // The tabs, not the rendering: schema keeps SwiftShader quick.
    await page.goto(`/dc/${await roomId(page)}?view=3d&mode=schema`);
    await waitForRoom(page);
    const themes = page.locator('.dc-top [role="radiogroup"]').last().getByRole("radio");
    for (const [i, theme] of THEMES.entries()) {
      await themes.nth(i).click();
      await expect(page.locator("html")).toHaveAttribute("data-dc-theme", theme);
      // Fonts and the relayout settle.
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
      await checkRow(page, `${theme} × ${lang}`);
    }
  });
