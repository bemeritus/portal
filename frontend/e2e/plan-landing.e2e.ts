/**
 * FEEDBACK-2 §3: in the drawing theme a room opens on its plan (orthographic, from
 * above) unless the link says what to show; the other themes open on 3D;
 * switching the theme while the room is open never moves the camera.
 */
import { expect, test, type Page } from "@playwright/test";

import { change, engine, keepAccountAsFound, roomId, setLanguage, setSettings, signIn, waitForRoom, type Theme } from "./helpers";

keepAccountAsFound();

type View = { position: number[]; target: number[]; fov: number; ortho: boolean };
const view = (page: Page) => engine(page, (e) => e.view()) as Promise<View>;

/** Orthographic and looking straight down. */
function isPlan(v: View) {
  const [dx, dy, dz] = [0, 1, 2].map((i) => v.position[i] - v.target[i]);
  return v.ortho && dy > 0 && Math.hypot(dx, dz) < 0.05 * dy;
}

async function open(page: Page, theme: Theme, path: string) {
  await setSettings(page, { dc_theme: theme });
  await page.goto(path);
  await waitForRoom(page);
  await page.waitForTimeout(300);
}

test("drawing opens on the plan; links and other themes keep their view", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  const id = await roomId(page);

  // Drawing theme, nothing in the link: the plan.
  await open(page, "drawing", `/dc/${id}`);
  await expect(page).toHaveURL(/[?&]view=plan/);
  await expect(page.locator('.dc-top nav [aria-current="page"]')).toHaveText("План");
  expect(isPlan(await view(page))).toBe(true);

  // Studio and light: 3D, as before.
  for (const theme of ["studio", "light"] as const) {
    await open(page, theme, `/dc/${id}`);
    await expect(page).not.toHaveURL(/view=plan/);
    expect(isPlan(await view(page)), theme).toBe(false);
  }

  // An explicit link wins in drawing: the 3D tab, a camera, a selection.
  await open(page, "drawing", `/dc/${id}?view=3d`);
  await expect(page).not.toHaveURL(/view=plan/);
  expect(isPlan(await view(page))).toBe(false);
  await open(page, "drawing", `/dc/${id}?cam=6000,4000,9000,2700,800,2000,50,0`);
  await expect(page).not.toHaveURL(/view=plan/);
  // The camera flies there.
  await expect
    .poll(async () => (await view(page)).position.map((x) => Math.round(x / 10) * 10))
    .toEqual([6000, 4000, 9000]);
  expect((await view(page)).ortho).toBe(false);
  await open(page, "drawing", `/dc/${id}#obj-1`);
  await expect(page).not.toHaveURL(/view=plan/);

  // From the racks page, the 3D tab is a choice, not a fresh open.
  await page.goto(`/dc/${id}/racks`);
  await page.locator(".dc-top nav").getByRole("link", { name: "3D", exact: true }).click();
  await waitForRoom(page);
  await expect(page).toHaveURL(/view=3d/);
  expect(isPlan(await view(page))).toBe(false);
});

test("switching the theme while the room is open does not move the camera", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  const id = await roomId(page);
  const themes = page.locator('.dc-top [role="radiogroup"]').last().getByRole("radio");

  // On the plan in drawing → studio, light, back: same camera, same page.
  await open(page, "drawing", `/dc/${id}`);
  await expect(page).toHaveURL(/view=plan/);
  const onPlan = await view(page);
  for (const i of [0, 2, 1]) {
    await themes.nth(i).click();
    await page.waitForTimeout(300);
    expect(await view(page)).toEqual(onPlan);
    await expect(page).toHaveURL(/view=plan/);
  }

  // In 3D in studio → drawing: still 3D, same camera.
  await open(page, "studio", `/dc/${id}`);
  const in3d = await view(page);
  await themes.nth(1).click();
  await expect(page.locator("html")).toHaveAttribute("data-dc-theme", "drawing");
  await page.waitForTimeout(300);
  expect(await view(page)).toEqual(in3d);
  await expect(page).not.toHaveURL(/view=plan/);
});

test("a saved view opened on the plan wins over it", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  const id = await roomId(page);
  const name = `e2e ${Date.now()}`;
  await change(page, id, [
    {
      op: "annotation_create",
      annotation: {
        kind: "view",
        payload: { name, position: [6000, 4000, 9000], target: [2700, 800, 2000], fov: 50, ortho: false, shared: false },
      },
    },
  ]);
  try {
    await open(page, "drawing", `/dc/${id}`);
    await expect(page).toHaveURL(/view=plan/);
    await page.locator(".dc-inspector").getByRole("tab", { name: "Виды" }).click();
    await page.locator(".dc-inspector").getByRole("button", { name }).click();
    await expect(page).toHaveURL(/view=3d/);
    await expect
      .poll(async () => (await view(page)).position.map((x) => Math.round(x / 10) * 10))
      .toEqual([6000, 4000, 9000]);
  } finally {
    const room = (await (await page.request.get(`/api/dc/rooms/${id}`)).json()) as {
      annotations: { id: number; kind: string; payload: { name?: string } }[];
    };
    const mine = room.annotations.find((a) => a.kind === "view" && a.payload.name === name);
    if (mine) await change(page, id, [{ op: "annotation_delete", id: mine.id }]);
  }
});
