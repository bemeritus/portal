/**
 * FEEDBACK-3 §3, FEEDBACK-5 §1, FEEDBACK-6 §1: a service-clearance shortfall,
 * decided by the tape where the tape read the very gap. Rack 1 is 595 mm
 * behind by the model but 610 by the tape: it passes, and its zone is amber
 * because model and tape disagree about it. Rack 2 is 585 by the model and
 * 555 by the tape: it warns.
 *
 * The warning is a pin in the scene («сзади 55,5 см») and a compact card in
 * the room's summary; either selects the rack, frames the gap and shows the
 * full explanation — how much room there is and to what, what servicing
 * needs and what will not work.
 */
import { expect, test, type Page } from "@playwright/test";

import { engine, keepAccountAsFound, roomId, setLanguage, setSettings, signIn, waitForRoom } from "./helpers";

keepAccountAsFound();

type Shown = { objectId: number; side: string; mm: number } | null;
type Zone = { objectId: number; side: string; state: string };
interface WithClearance {
  shownClearance(): Shown;
  clearanceZones(): Zone[];
}
const shown = (page: Page) => engine(page, (e) => (e as unknown as WithClearance).shownClearance());

test("clearance warning: by the tape, card and pin, the explanation, plan zones", async ({ page }) => {
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

  await page.goto(`/dc/${id}?view=3d&mode=schema`);
  await waitForRoom(page);

  // Nothing selected: the summary's card — rack 2 only, by the tape.
  const cards = page.getByTestId("summary-warnings").getByRole("button");
  await expect(cards).toHaveCount(1);
  await expect(cards).toHaveText(
    "Мало места для обслуживанияСтойка 2: сзади 555 мм по рулетке, нужно 600. Показать",
  );
  // No wall of text in the panel.
  await expect(page.locator(".dc-inspector").getByTestId("clearance-warning")).toHaveCount(0);

  // The card: the rack selected, its gap drawn, the full explanation.
  await cards.click();
  await expect(page).toHaveURL(/#obj-\d+$/);
  await expect(page.locator(".dc-inspector h2")).toContainText("Стойка 2");
  await expect.poll(() => shown(page)).toMatchObject({ side: "rear", mm: 555 });
  const full = page.locator(".dc-inspector").getByTestId("clearance-warning");
  await expect(full.getByRole("button")).toHaveText(
    "Стойка 2: сзади 555 мм по рулетке до стены. Для обслуживания нужно 600 мм — задняя дверь может не открыться полностью, сервер на салазках может не выдвинуться.",
  );

  // In every mode, not only schema.
  await page.getByRole("radio", { name: "Реалистичный" }).click();
  await expect.poll(() => shown(page)).toMatchObject({ side: "rear", mm: 555 });

  // Rack 1 passes by the tape, and says why the model would not.
  await page.evaluate((n) => (window.location.hash = `#obj-${n}`), idOf("Стойка 1"));
  await expect.poll(() => shown(page)).toBeNull();
  await page.locator(".dc-inspector summary").click();
  const fine = page.locator(".dc-inspector").getByTestId("clearance-rear");
  await expect(fine).toContainText("Свободно сзади: 610 мм по рулетке (нужно 600 мм)");
  await expect(fine).toContainText("Модель и рулетка расходятся: 595 и 610 мм. Проверка по рулетке.");
  await expect(page.locator(".dc-inspector").getByTestId("clearance-warning")).toHaveCount(0);

  // The plan: rack 2's rear zone red with a pin, rack 1's amber; the pins
  // say side and value, their tooltip the rest.
  await setSettings(page, { dc_unit: "cm" });
  await page.goto(`/dc/${id}?view=plan&mode=schema`);
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
  const pin = labels.locator(".dc-label-pin");
  await expect(pin).toHaveText(["сзади 55,5 см"]);
  await expect(pin).toHaveAttribute("title", "Сзади 55,5 см по рулетке — нужно 60");
  const amber = labels.locator('.dc-label-caution[data-key^="pin:"]');
  await expect(amber).toHaveText(["сзади 61 см"]);
  await expect(amber).toHaveAttribute(
    "title",
    "Сзади 61 см по рулетке — нужно 60\nМодель и рулетка расходятся: 59,5 и 61 см. Проверка по рулетке.",
  );
  // A pin opens the explanation.
  await pin.click();
  await expect(page.locator(".dc-inspector h2")).toContainText("Стойка 2");
  await expect(page.locator(".dc-inspector").getByTestId("clearance-warning")).toBeVisible();

  // English says the same.
  await setLanguage(page, "en");
  await setSettings(page, { dc_unit: "mm" });
  await page.goto(`/dc/${id}?view=3d&mode=schema`);
  await waitForRoom(page);
  await expect(page.getByTestId("summary-warnings")).toContainText("Стойка 2: 555 mm behind by tape, 600 needed.");
});

test("plan legend: in the title block's corner, plain words, folds per user", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "drawing", dc_unit: "cm", dc_legend_collapsed: false });
  const id = await roomId(page);
  await page.goto(`/dc/${id}?view=plan&mode=schema`);
  await waitForRoom(page);

  // Only what is drawn: the plan's chain carries a tape reading the model
  // disagrees with (149,5–150 •), so the dot is explained.
  const legend = page.locator(".dc-legend-sheet");
  const dot =
    "Точка у размера — замер рулеткой и модель расходятся больше чем на 0,5 см. Наведите на размер, чтобы увидеть оба значения";
  await expect(legend.locator("li")).toHaveText([
    "Пунктир — висит над полом: кондиционеры, кабельный лоток",
    dot,
    "Красная зона — мало места для обслуживания: меньше 60 см",
    "Жёлтая зона — модель и рулетка расходятся, проверка по рулетке",
  ]);
  // The chains off: no dimension carries a dot, so no dot entry.
  await page.getByTestId("layers").click();
  await page.getByRole("menuitemcheckbox", { name: "Цепочки размеров (план)" }).click();
  await page.keyboard.press("Escape");
  await expect(legend.locator("li")).toHaveText([
    "Пунктир — висит над полом: кондиционеры, кабельный лоток",
    "Красная зона — мало места для обслуживания: меньше 60 см",
    "Жёлтая зона — модель и рулетка расходятся, проверка по рулетке",
  ]);
  await page.evaluate(() => localStorage.removeItem("dc.layers"));

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

  // Realistic draws the zones (a layer in every mode), not the dashes.
  await page.getByRole("radio", { name: "Реалистичный" }).click();
  await expect(legend.locator("li")).toHaveText([
    "Красная зона — мало места для обслуживания: меньше 60 см",
    "Жёлтая зона — модель и рулетка расходятся, проверка по рулетке",
  ]);
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
