/**
 * FEEDBACK-1 §4: the ruler in the seeded room. r1's back face to the back
 * wall reads 595 mm face ⟂ face; the gap between r3 and r4 reads 200 mm.
 */
import { expect, test, type Page } from "@playwright/test";

type Vec3 = [number, number, number];
interface Engine {
  boxNamed(name: string): { min: Vec3; max: Vec3 } | null;
  project(p: Vec3): [number, number];
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.locator("input").first().fill(process.env.E2E_USER ?? "dcedit");
  await page.locator("input[type=password]").fill(process.env.E2E_PASSWORD ?? "testpass1");
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

/** Click a world point (mm) in the 3D view. */
async function clickAt(page: Page, p: Vec3) {
  const [x, y] = await page.evaluate((q) => (window as unknown as { __dcEngine: Engine }).__dcEngine.project(q), p);
  const box = (await page.locator(".dc-viewport canvas").first().boundingBox())!;
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.click(box.x + x, box.y + y);
}

const boxOf = (page: Page, name: string) =>
  page.evaluate((n) => (window as unknown as { __dcEngine: Engine }).__dcEngine.boxNamed(n), name).then((b) => {
    if (!b) throw new Error(`no ${name} in the room`);
    return b;
  });

test("ruler: r1 back face to the back wall, and the r3–r4 gap", async ({ page }) => {
  await signIn(page);
  const rooms = (await (await page.request.get("/api/dc/rooms")).json()) as { id: number }[];
  await page.goto(`/dc/${rooms[0].id}?tool=ruler`);
  await page.waitForFunction(() => !!(window as unknown as { __dcEngine?: Engine }).__dcEngine?.boxNamed("Стойка 1"));
  await page.getByRole("radio", { name: "мм", exact: true }).click();
  // From the z = width side ("front" of the room's model axes): the racks'
  // back faces and the wall behind them face the camera.
  await page.evaluate(() => (window as unknown as { __dcEngine: { preset(p: string, d: number): void } }).__dcEngine.preset("front", 0));
  await page.waitForTimeout(300);

  const r1 = await boxOf(page, "Стойка 1");
  const cx = (r1.min[0] + r1.max[0]) / 2;
  await clickAt(page, [cx + 37, 1100, r1.max[2]]); // the back face, off-centre
  await clickAt(page, [cx - 120, 150, r1.max[2] + 595 + 30]); // the back wall
  await expect(page.getByTestId("ruler-text").first()).toHaveText(/грань ⟂ грань · 595 мм/);

  await page.getByRole("button", { name: "Убрать замеры" }).click();
  await page.getByRole("radio", { name: "Зазор между объектами" }).click();
  const r3 = await boxOf(page, "Стойка 3");
  const r4 = await boxOf(page, "Стойка 4");
  const mid = (b: { min: Vec3; max: Vec3 }): Vec3 => [(b.min[0] + b.max[0]) / 2, 1000, b.max[2]];
  await clickAt(page, mid(r3));
  await clickAt(page, mid(r4));
  await expect(page.getByTestId("ruler-text").first()).toHaveText(/зазор между объектами · 200 мм/);
});
