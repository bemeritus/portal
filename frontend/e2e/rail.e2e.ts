/**
 * FEEDBACK-3 §1: in the docked tool rail (the drawing theme) the break
 * between tool groups is one rule, not two parallel lines. The review asked
 * for "no two horizontal rules closer than 2 px"; the lines it reported were
 * 3 px apart (a 1 px border, then the <hr>'s 4 px margin), so this checks
 * that every two rules have at least half a button between them. The
 * floating rail (studio, light) keeps its own separator.
 */
import { expect, test, type Page } from "@playwright/test";

import { keepAccountAsFound, roomId, setLanguage, setSettings, signIn, THEMES, waitForRoom } from "./helpers";

keepAccountAsFound();

/** Every visible horizontal border in the rail: [top, bottom] in px. */
function rules(page: Page) {
  return page.locator(".dc-rail").evaluate((rail) => {
    const out: [number, number][] = [];
    for (const el of rail.querySelectorAll<HTMLElement>(":scope > *")) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const top = parseFloat(cs.borderTopWidth);
      const bottom = parseFloat(cs.borderBottomWidth);
      if (top > 0 && cs.borderTopStyle !== "none") out.push([r.top, r.top + top]);
      if (bottom > 0 && cs.borderBottomStyle !== "none") out.push([r.bottom - bottom, r.bottom]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  });
}

for (const theme of THEMES)
  test(`tool rail separators: ${theme}`, async ({ page }) => {
    await signIn(page);
    await setLanguage(page, "ru");
    await setSettings(page, { dc_theme: theme });
    await page.goto(`/dc/${await roomId(page)}?view=3d`);
    await waitForRoom(page);
    const docked = (await page.locator(".dc-rail").getAttribute("data-docked")) === "true";
    expect(docked).toBe(theme === "drawing");

    const rs = await rules(page);
    // Two rules with no button between them read as a double line.
    const half = (await page.locator(".dc-rail > button").first().boundingBox())!.height / 2;
    for (let i = 1; i < rs.length; i++)
      expect(rs[i][0] - rs[i - 1][1], `${theme}: rules ${i - 1} and ${i}`).toBeGreaterThanOrEqual(half);

    const hr = page.locator(".dc-rail > hr");
    if (docked) {
      // The group break: the <hr> draws nothing; the button above it ends in
      // the one heavier rule.
      const own = await hr.evaluate((el) => {
        const cs = getComputedStyle(el);
        return [cs.borderTopWidth, cs.borderBottomWidth, cs.marginTop, cs.marginBottom];
      });
      expect(own).toEqual(["0px", "0px", "0px", "0px"]);
      const above = await page
        .locator(".dc-rail > button:has(+ hr)")
        .evaluate((el) => getComputedStyle(el).borderBottomWidth);
      expect(above).toBe("2px");
    } else {
      // Floating: unchanged, a thin line with its margin.
      const own = await hr.evaluate((el) => {
        const cs = getComputedStyle(el);
        return [cs.borderTopWidth, cs.marginTop];
      });
      expect(own).toEqual(["1px", "4px"]);
    }
  });
