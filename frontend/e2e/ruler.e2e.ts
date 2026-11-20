/**
 * FEEDBACK-1 §4: the ruler in the seeded room. r1's back face to the back
 * wall reads 595 mm face ⟂ face; the gap between r3 and r4 reads 200 mm.
 */
import { expect, test, type Page } from "@playwright/test";

import { engine, keepAccountAsFound, pointAt, roomId, setLanguage, setSettings, signIn, waitForRoom, type Vec3 } from "./helpers";

keepAccountAsFound();

const boxOf = (page: Page, name: string) =>
  page.evaluate((n) => (window as unknown as { __dcEngine: { boxNamed(n: string): { min: Vec3; max: Vec3 } | null } }).__dcEngine.boxNamed(n), name).then((b) => {
    if (!b) throw new Error(`no ${name} in the room`);
    return b;
  });

test("ruler: r1 back face to the back wall, and the r3–r4 gap", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio" });
  await page.goto(`/dc/${await roomId(page)}?view=3d&mode=schema&tool=ruler`);
  await waitForRoom(page);
  await page.getByRole("radio", { name: "мм", exact: true }).click();
  // From the z = width side — behind the racks, whose fronts face the shelf
  // (FEEDBACK-7 §2.1: «front» is the racks' front now): the racks'
  // back faces and the wall behind them face the camera.
  await engine(page, (e) => e.preset("back", 0));
  await page.waitForTimeout(300);

  const r1 = await boxOf(page, "Стойка 1");
  const cx = (r1.min[0] + r1.max[0]) / 2;
  await pointAt(page, [cx + 37, 1100, r1.max[2]]); // the back face, off-centre
  await pointAt(page, [cx - 120, 150, r1.max[2] + 595 + 30]); // the back wall
  await expect(page.getByTestId("ruler-text").first()).toHaveText(/грань ⟂ грань · 595 мм/);

  await page.getByRole("button", { name: "Убрать замеры" }).click();
  await page.getByRole("radio", { name: "Зазор между объектами" }).click();
  const r3 = await boxOf(page, "Стойка 3");
  const r4 = await boxOf(page, "Стойка 4");
  const mid = (b: { min: Vec3; max: Vec3 }): Vec3 => [(b.min[0] + b.max[0]) / 2, 1000, b.max[2]];
  await pointAt(page, mid(r3));
  await pointAt(page, mid(r4));
  await expect(page.getByTestId("ruler-text").first()).toHaveText(/зазор между объектами · 200 мм/);
});
