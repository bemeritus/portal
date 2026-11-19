/**
 * FEEDBACK-3 §3: a service-clearance shortfall says what it means — how much
 * room there is and to what, what servicing needs and what will not work —
 * and clicking it selects the rack and draws the gap with its dimension, in
 * every mode.
 *
 * FEEDBACK-5 §1: where the tape read the very gap, the tape decides. Rack 1
 * is 595 mm behind by the model but 610 by the tape: it passes, and its zone
 * is amber because model and tape disagree about it. Rack 2 is 585 by the
 * model and 555 by the tape: it warns, in red.
 */
import { expect, test } from "@playwright/test";

import { engine, keepAccountAsFound, roomId, setLanguage, setSettings, signIn, waitForRoom } from "./helpers";

keepAccountAsFound();

type Shown = { objectId: number; side: string; mm: number } | null;
type Zone = { objectId: number; side: string; state: string };
interface WithClearance {
  shownClearance(): Shown;
  clearanceZones(): Zone[];
}
const shown = (page: import("@playwright/test").Page) =>
  engine(page, (e) => (e as unknown as WithClearance).shownClearance());

test("clearance warning: by the tape, wording, click to the gap, plan zones", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio", dc_unit: "mm" });
  const id = await roomId(page);
  const room = (await (await page.request.get(`/api/dc/rooms/${id}`)).json()) as {
    objects: { id: number; name: string }[];
    analysis: { clearances: { object: string; side: string; basis: string; measured_mm: number | null; model_mm: number }[] };
  };
  const idOf = (name: string) => room.objects.find((o) => o.name === name)!.id;

  // The API says what each check went by.
  const rear = (name: string) => room.analysis.clearances.find((c) => c.object === name && c.side === "rear")!;
  expect(rear("Стойка 1")).toMatchObject({ basis: "measured", measured_mm: 610, model_mm: 595 });
  expect(rear("Стойка 2")).toMatchObject({ basis: "measured", measured_mm: 555, model_mm: 585 });

  await page.goto(`/dc/${id}?view=3d`);
  await waitForRoom(page);

  // Nothing selected: the room's shortfalls — rack 2 only, by the tape.
  const warning = page.locator(".dc-inspector").getByTestId("clearance-warning");
  await expect(warning).toContainText("Мало места для обслуживания");
  await expect(warning.getByRole("button")).toHaveCount(1);
  const r2 = warning.getByRole("button", { name: /^Стойка 2:/ });
  await expect(r2).toHaveText(
    "Стойка 2: сзади 555 мм по рулетке до стены. Для обслуживания нужно 600 мм — задняя дверь может не открыться полностью, сервер на салазках может не выдвинуться.",
  );
  await expect(warning).not.toContainText("Стойка 1");
  await expect(warning).toContainText(
    "Это предупреждение по замерам, а не ошибка в модели. Размеры не меняйте — отметьте, если так задумано.",
  );

  // Click: the rack is selected and its gap drawn, as the ruler draws.
  await r2.click();
  await expect(page).toHaveURL(/#obj-\d+$/);
  await expect(page.locator(".dc-inspector h2")).toContainText("Стойка 2");
  await expect.poll(() => shown(page)).toMatchObject({ side: "rear", mm: 555 });

  // In every mode, not only schema.
  await page.getByRole("radio", { name: "Реалистичный" }).click();
  await expect.poll(() => shown(page)).toMatchObject({ side: "rear", mm: 555 });

  // Rack 1 passes by the tape, and says why the model would not.
  await page.evaluate((n) => (window.location.hash = `#obj-${n}`), idOf("Стойка 1"));
  await expect.poll(() => shown(page)).toBeNull();
  const fine = page.locator(".dc-inspector").getByTestId("clearance-rear");
  await expect(fine).toContainText("Свободно сзади: 610 мм по рулетке (нужно 600 мм)");
  await expect(fine).toContainText("Модель и рулетка расходятся: 595 и 610 мм. Проверка по рулетке.");
  await expect(page.locator(".dc-inspector").getByTestId("clearance-warning")).toHaveCount(0);

  // The plan: rack 2's rear zone red, rack 1's amber, labelled with side,
  // value, requirement and basis.
  await setSettings(page, { dc_unit: "cm" });
  await page.goto(`/dc/${id}?view=plan`);
  await waitForRoom(page);
  const zones = () => engine(page, (e) => (e as unknown as WithClearance).clearanceZones());
  await expect
    .poll(zones)
    .toEqual(
      expect.arrayContaining([
        { objectId: idOf("Стойка 1"), side: "rear", state: "split" },
        { objectId: idOf("Стойка 2"), side: "rear", state: "short" },
      ]),
    );
  expect((await zones()).filter((z) => z.state === "short")).toHaveLength(1);
  const labels = page.locator(".dc-labels");
  await expect(labels.locator(".dc-label-warn")).toHaveText(["Сзади 55,5 см по рулетке — нужно 60"]);
  await expect(labels.locator(".dc-label-caution")).toHaveText([
    "Сзади 61 см по рулетке — нужно 60\nМодель и рулетка расходятся: 59,5 и 61 см. Проверка по рулетке.",
  ]);

  // English says the same.
  await setLanguage(page, "en");
  await setSettings(page, { dc_unit: "mm" });
  await page.goto(`/dc/${id}?view=3d`);
  await waitForRoom(page);
  await expect(page.locator(".dc-inspector").getByTestId("clearance-warning")).toContainText(
    "Стойка 2: 555 mm behind by tape, to the wall. Servicing needs 600 mm",
  );
});

test("plan legend: in the title block's corner, plain words, folds per user", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "drawing", dc_unit: "cm", dc_legend_collapsed: false });
  const id = await roomId(page);
  await page.goto(`/dc/${id}?view=plan`);
  await waitForRoom(page);

  const legend = page.locator(".dc-legend-sheet");
  await expect(legend.locator("li")).toHaveText([
    "Пунктир — висит над полом: кондиционеры, кабельный лоток",
    "Точка у размера — замер рулеткой и модель расходятся больше чем на 0,5 см. Наведите на размер, чтобы увидеть оба значения",
    "Красная зона — мало места для обслуживания: меньше 60 см",
    "Жёлтая зона — модель и рулетка расходятся, проверка по рулетке",
  ]);

  // Above the title block, clear of the view cube and the mode bar.
  const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
  const [l, title, cube, bar] = [
    await box(".dc-legend-sheet"),
    await box(".dc-titleblock"),
    await box(".dc-cube-wrap"),
    await box(".dc-modebar"),
  ];
  const apart = (a: typeof l, b: typeof l) =>
    a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
  expect(l.y + l.height).toBeLessThanOrEqual(title.y);
  expect(apart(l, cube)).toBe(true);
  expect(apart(l, bar)).toBe(true);

  // Realistic draws none of these marks: no legend at all.
  await page.getByRole("radio", { name: "Реалистичный" }).click();
  await expect(legend).toHaveCount(0);
  await page.getByRole("radio", { name: "Схема" }).click();

  // Folded to its button; the state is the user's, so it survives a reload.
  await legend.getByRole("button", { name: "Свернуть обозначения" }).click();
  await expect(legend).toHaveCount(0);
  const open = page.getByRole("button", { name: "Обозначения" });
  await expect(open).toBeVisible();
  await expect.poll(async () => (await (await page.request.get("/api/dc/settings")).json()).dc_legend_collapsed).toBe(true);
  await page.reload();
  await waitForRoom(page);
  await expect(open).toBeVisible();
  await open.click();
  await expect(legend).toBeVisible();

  // Uzbek and English, through the same keys.
  await setLanguage(page, "en");
  await page.reload();
  await waitForRoom(page);
  await expect(legend).toContainText("Red zone — too little room for servicing: less than 60 cm");
  await setLanguage(page, "uz");
  await page.reload();
  await waitForRoom(page);
  await expect(legend).toContainText("Qizil zona — xizmat ko'rsatish uchun joy kam: 60 sm dan kam");
});
