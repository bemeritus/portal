/**
 * FEEDBACK-3 §3: a service-clearance shortfall says what it means — how much
 * room there is and to what, what servicing needs and what will not work —
 * and clicking it selects the rack and draws the gap with its dimension, in
 * every mode. The numbers are the measured ones (r1: 595 mm behind, 600 mm
 * needed).
 */
import { expect, test } from "@playwright/test";

import { engine, keepAccountAsFound, roomId, setLanguage, setSettings, signIn, waitForRoom } from "./helpers";

keepAccountAsFound();

type Shown = { objectId: number; side: string; mm: number } | null;
interface WithClearance {
  shownClearance(): Shown;
}
const shown = (page: import("@playwright/test").Page) =>
  engine(page, (e) => (e as unknown as WithClearance).shownClearance());

test("clearance warning: wording, click to the gap, plan legend", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio", dc_unit: "mm" });
  const id = await roomId(page);
  await page.goto(`/dc/${id}?view=3d`);
  await waitForRoom(page);

  // Nothing selected: the room's shortfalls, in words a technician can use.
  const warning = page.locator(".dc-inspector").getByTestId("clearance-warning");
  await expect(warning).toContainText("Мало места для обслуживания");
  const r1 = warning.getByRole("button", { name: /^Стойка 1:/ });
  await expect(r1).toHaveText(
    "Стойка 1: сзади 595 мм до стены. Для обслуживания нужно 600 мм — задняя дверь может не открыться полностью, сервер на салазках может не выдвинуться.",
  );
  await expect(warning).toContainText(
    "Это предупреждение по замерам, а не ошибка в модели. Размеры не меняйте — отметьте, если так задумано.",
  );
  await expect(warning).not.toContainText("Сервисная зона");

  // Click: the rack is selected and its gap drawn, as the ruler draws.
  await r1.click();
  await expect(page).toHaveURL(/#obj-\d+$/);
  await expect(page.locator(".dc-inspector h2")).toContainText("Стойка 1");
  await expect.poll(() => shown(page)).toMatchObject({ side: "rear", mm: 595 });
  // The selected rack says the same, and its line draws the gap too.
  const own = page.locator(".dc-inspector").getByTestId("clearance-warning");
  await expect(own.getByRole("button")).toHaveText(/^Стойка 1: сзади 595 мм до стены\./);

  // In every mode, not only schema.
  await page.getByRole("radio", { name: "Реалистичный" }).click();
  await expect.poll(() => shown(page)).toMatchObject({ side: "rear", mm: 595 });

  // Selecting something else ends it; the rack's own warning brings it back.
  const room = (await (await page.request.get(`/api/dc/rooms/${id}`)).json()) as {
    objects: { id: number; name: string }[];
  };
  const r3 = room.objects.find((o) => o.name === "Стойка 3")!;
  await page.evaluate((n) => (window.location.hash = `#obj-${n}`), r3.id);
  await expect.poll(() => shown(page)).toBeNull();
  await page.evaluate((n) => (window.location.hash = `#obj-${n}`), room.objects.find((o) => o.name === "Стойка 1")!.id);
  await own.getByRole("button").click();
  await expect.poll(() => shown(page)).toMatchObject({ side: "rear", mm: 595 });

  // The plan legend says what is short and by how much.
  await page.goto(`/dc/${id}?view=plan`);
  await waitForRoom(page);
  await expect(page.locator(".dc-legend-sheet")).toContainText("мало места для обслуживания (< 600 мм)");

  // English says the same.
  await setLanguage(page, "en");
  await page.goto(`/dc/${id}?view=3d`);
  await waitForRoom(page);
  await expect(page.locator(".dc-inspector").getByTestId("clearance-warning")).toContainText(
    "Стойка 1: 595 mm behind, to the wall. Servicing needs 600 mm",
  );
});
