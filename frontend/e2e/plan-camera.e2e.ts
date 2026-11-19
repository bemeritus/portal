/**
 * FEEDBACK-5 §4: «План» is a plan — orthographic and straight down, orbit
 * off, only pan and zoom. Turning the view (a right drag, the view cube)
 * leaves for «3D» with a smooth flight, and the 3D tab lights up.
 */
import { expect, test, type Page } from "@playwright/test";

import { engine, keepAccountAsFound, roomId, setLanguage, setSettings, signIn, waitForRoom } from "./helpers";

keepAccountAsFound();

type View = { position: number[]; target: number[]; fov: number; ortho: boolean };
const view = (page: Page) => engine(page, (e) => e.view()) as Promise<View>;
const locked = (page: Page) =>
  engine(page, (e) => (e as unknown as { planLocked(): boolean }).planLocked());

/** Orthographic and looking straight down. */
function isPlan(v: View) {
  const [dx, dy, dz] = [0, 1, 2].map((i) => v.position[i] - v.target[i]);
  return v.ortho && dy > 0 && Math.hypot(dx, dz) < 0.05 * dy;
}

async function openPlan(page: Page, id: number) {
  await page.goto(`/dc/${id}?view=plan`);
  await waitForRoom(page);
  await expect.poll(async () => isPlan(await view(page))).toBe(true);
  expect(await locked(page)).toBe(true);
}

test("the plan pans and zooms but never tilts; turning it goes to 3D", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio" });
  const id = await roomId(page);
  await openPlan(page, id);
  const canvas = (await page.locator(".dc-viewport canvas").first().boundingBox())!;
  const cx = canvas.x + canvas.width / 2,
    cy = canvas.y + canvas.height / 2;

  // A left drag pans: the target moves, the view stays straight down.
  const before = await view(page);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 160, cy + 90, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const panned = await view(page);
  expect(isPlan(panned)).toBe(true);
  expect(Math.hypot(panned.target[0] - before.target[0], panned.target[2] - before.target[2])).toBeGreaterThan(100);
  await expect(page).toHaveURL(/view=plan/);

  // The wheel zooms, still straight down.
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(300);
  expect(isPlan(await view(page))).toBe(true);

  // A right drag is the rotate gesture: 3D, with the 3D tab lit, flown to.
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(cx + 120, cy - 40, { steps: 6 });
  await page.mouse.up({ button: "right" });
  await expect(page).toHaveURL(/view=3d/);
  await expect(page.locator('.dc-top nav [aria-current="page"]')).toHaveText("3D");
  expect(await locked(page)).toBe(false);
  // Smooth: part-way through the flight the camera is between the two.
  await page.waitForTimeout(150);
  const mid = await view(page);
  expect(isPlan(mid)).toBe(false);
  await expect.poll(async () => (await view(page)).ortho).toBe(false);

  // The view cube on the plan: a side face goes to 3D too.
  await openPlan(page, id);
  // (Seen from above the side faces are edge-on: click the element itself.)
  await page.locator('.dc-cube-face[data-dc-face="front"]').dispatchEvent("click");
  await expect(page).toHaveURL(/view=3d/);
  await expect(page.locator('.dc-top nav [aria-current="page"]')).toHaveText("3D");
  // Its own top face keeps the plan.
  await openPlan(page, id);
  await page.locator('.dc-cube-face[data-dc-face="top"]').dispatchEvent("click");
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/view=plan/);
  expect(isPlan(await view(page))).toBe(true);
});
