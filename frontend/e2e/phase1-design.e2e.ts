/**
 * FEEDBACK-6: the design pass that closes phase 1. One file, in order: the
 * room as seeded (nothing recorded), then with the example inventory
 * imported — which is itself a check (§8: ~100 devices, one revision,
 * under 2 s).
 */
import { expect, test, type Page } from "@playwright/test";

import { importExample } from "./inventory";
import { engine, keepAccountAsFound, roomId, setLanguage, setSettings, signIn, waitForRoom } from "./helpers";

keepAccountAsFound();
test.describe.configure({ mode: "serial" });

interface Shown {
  labelsShown(): string[];
}
const labels = (page: Page) => engine(page, (e) => (e as unknown as Shown).labelsShown());

async function idOf(page: Page, name: string): Promise<number> {
  const room = (await (await page.request.get(`/api/dc/rooms/${await roomId(page)}`)).json()) as {
    objects: { id: number; name: string }[];
  };
  return room.objects.find((o) => o.name === name)!.id;
}

test("as seeded: calm defaults, the summary's empty state, the racks' message", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio", dc_unit: "cm", dc_mode: null });
  const id = await roomId(page);

  // Studio opens realistic; nothing selected is the room's summary.
  await page.goto(`/dc/${id}`);
  await waitForRoom(page);
  await expect(page.getByRole("radio", { name: "Реалистичный" })).toHaveAttribute("aria-checked", "true");
  const summary = page.getByTestId("room-summary");
  await expect(summary).toContainText("Оборудование ещё не заведено");
  await expect(summary.getByRole("button", { name: "Импорт CSV" })).toBeVisible();
  await expect(page.locator(".dc-inspector")).toContainText(/Комната · ревизия \d+/);
  // No breadcrumb chip without a selection, no revision in the corner.
  await expect(page.getByTestId("breadcrumb")).toHaveCount(0);
  await expect(page.locator(".dc-coords")).toHaveCount(0);

  // Drawing opens on the plan.
  await setSettings(page, { dc_theme: "drawing" });
  await page.goto(`/dc/${id}`);
  await expect(page).toHaveURL(/view=plan/);
  await waitForRoom(page);
  await expect(page.getByRole("radio", { name: "Схема" })).toHaveAttribute("aria-checked", "true");

  // A rack without recorded contents: «нет данных», not a dash.
  await setSettings(page, { dc_theme: "studio" });
  await page.goto(`/dc/${id}?view=3d&mode=schema#obj-${await idOf(page, "Стойка 3")}`);
  await waitForRoom(page);
  const rack = page.getByTestId("rack-summary");
  await expect(rack).toContainText("нет данных");
  await expect(page.locator(".dc-inspector")).toContainText("Стойка · 60 × 100 × 204 · 42U");

  // The racks page: one message and the template, not four empty racks.
  await page.goto(`/dc/${id}/racks`);
  const empty = page.getByTestId("racks-empty");
  await expect(empty).toContainText("Содержимое стоек ещё не заведено.");
  await expect(empty.getByRole("link", { name: "Скачать шаблон CSV" })).toHaveAttribute("href", /template\.csv$/);
  await expect(page.getByTestId("rack-card")).toHaveCount(0);

  // The template: the user's headers, this room's racks, power left empty.
  const tpl = await (await page.request.get(`/api/dc/rooms/${id}/import/template.csv`)).text();
  expect(tpl).toContain("стойка;сторона");
  expect(tpl).toContain("Серверная;Стойка 1;front;1;2;ups");
  expect(tpl).toContain("мощность неизвестна — оставьте пусто, не 0");
});

test("the import: ~100 devices, one revision, under 2 s", async ({ page }) => {
  await signIn(page);
  const id = await roomId(page);
  const before = ((await (await page.request.get(`/api/dc/rooms/${id}/revision`)).json()) as { revision: number })
    .revision;
  const t0 = Date.now();
  const r = await importExample(page, id);
  const ms = Date.now() - t0;
  console.log(`import of ${r.created} devices (dry run + apply): ${ms} ms`);
  expect(r.created).toBe(91);
  expect(r.revision).toBe(before + 1);
  expect(ms).toBeLessThan(2000);
});

test("the room: last mode remembered, layers, pins, chains, no overlaps, the bar", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio", dc_unit: "cm", dc_mode: null });
  const id = await roomId(page);

  // The last mode is the user's.
  await page.goto(`/dc/${id}?view=3d`);
  await waitForRoom(page);
  await page.getByRole("radio", { name: "Схема" }).click();
  await expect.poll(async () => (await (await page.request.get("/api/dc/settings")).json()).dc_mode).toBe("schema");
  await page.goto(`/dc/${id}?view=3d`);
  await waitForRoom(page);
  await expect(page.getByRole("radio", { name: "Схема" })).toHaveAttribute("aria-checked", "true");

  // Calm by default: of the measurements only the room's overall size; the
  // warnings as pins.
  await page.waitForTimeout(500);
  const meas = (await labels(page)).filter((k) => k.startsWith("meas:"));
  expect(meas.length).toBeGreaterThan(0);
  expect(meas.every((k) => k.startsWith("meas:room."))).toBe(true);
  expect(await labels(page)).toContain(`pin:${await idOf(page, "Стойка 2")}:rear`);

  // The layers list: gaps on → the tape gaps between objects appear.
  await page.getByTestId("layers").click();
  for (const name of [
    "Размеры комнаты",
    "Зазоры между объектами",
    "Цепочки размеров (план)",
    "Остальные замеры рулеткой",
    "Размеры выбранного",
    "Зоны обслуживания",
    "Подписи объектов",
    "Освещение",
    "Допущения",
  ])
    await expect(
      page.getByRole("menuitemcheckbox", { name: new RegExp(`^${name.replace(/[()]/g, "\\$&")}`) }),
    ).toBeVisible();
  await page.getByRole("menuitemcheckbox", { name: "Зазоры между объектами" }).click();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await labels(page)).some((k) => k.startsWith("meas:racks.gap."))).toBe(true);
  await page.evaluate(() => localStorage.removeItem("dc.layers"));

  // Selection: the rack's own dimensions and its gaps to the neighbours.
  const r3 = await idOf(page, "Стойка 3");
  await page.goto(`/dc/${id}?view=3d&mode=schema#obj-${r3}`);
  await waitForRoom(page);
  await expect
    .poll(async () => (await labels(page)).filter((k) => /^meas:racks\.(width|depth|height)\.r3$/.test(k)).length)
    .toBeGreaterThan(0);
  // Its gaps to the neighbours: as the tape reads them where the tape has
  // them (drawn once, FEEDBACK-7 §1.4), else measured in the model.
  expect((await labels(page)).some((k) => /^(gap:sel:|meas:racks\.gap)/.test(k))).toBe(true);
  await expect(page.getByTestId("breadcrumb")).toHaveText("Серверная›Стойка 3");

  // No two labels on top of each other.
  const boxes = await page.locator(".dc-labels > div").evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).style.display !== "none")
      .map((e) => ({ ...(e.getBoundingClientRect().toJSON() as DOMRect), text: e.textContent })),
  );
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i], boxes[j]];
      const overlap = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      expect(overlap, `«${a.text}» and «${b.text}»`).toBe(false);
    }

  // The plan: chain dimensions outside the room, along the bottom and right.
  await page.goto(`/dc/${id}?view=plan&mode=schema`);
  await waitForRoom(page);
  await expect.poll(async () => (await labels(page)).filter((k) => k.startsWith("chain:x:")).length).toBeGreaterThan(3);
  expect((await labels(page)).some((k) => k.startsWith("chain:z:"))).toBe(true);

  // The bar: modes · views · undo/redo · Экспорт ▾ · ⋯, every icon titled.
  const bar = page.locator(".dc-modebar");
  await expect(bar.getByRole("radiogroup")).toHaveCount(1);
  await expect(bar.getByRole("radio", { name: "Схема" })).toHaveAttribute("title", "Схема");
  await expect(bar.getByRole("button", { name: "Общий" })).toHaveAttribute("title", "Общий");
  await expect(bar.getByRole("button", { name: "Сверху" })).toHaveAttribute("title", "Сверху (7)");
  for (const b of await bar.locator("button:not([role=radio])").all())
    expect(((await b.getAttribute("title")) ?? (await b.textContent()) ?? "").trim().length).toBeGreaterThan(0);
  await bar.getByRole("button", { name: "Экспорт" }).click();
  for (const name of ["PNG", "DXF", "CSV"]) await expect(page.getByRole("menuitem", { name: new RegExp(name) })).toBeVisible();
  await page.keyboard.press("Escape");
  await bar.getByRole("button", { name: "Ещё" }).click();
  for (const name of ["Импорт CSV", "Сбросить расстановку", "История", "Сохранённые виды"])
    await expect(page.getByRole("menuitem", { name })).toBeVisible();
  await page.keyboard.press("Escape");

  // The view cube: in a 96 px box it fits at any angle (FEEDBACK-7 §2.3),
  // bottom left above the bar, clear of the legend.
  const cube = (await page.locator(".dc-cube-wrap").boundingBox())!;
  expect(Math.round(cube.width)).toBe(96);
  const barBox = (await bar.boundingBox())!;
  expect(cube.y + cube.height).toBeLessThanOrEqual(barBox.y);
  const legend = await page.locator(".dc-legend-sheet").boundingBox();
  if (legend) expect(cube.x + cube.width <= legend.x || cube.y + cube.height <= legend.y).toBe(true);
});

test("the room summary and the selected rack", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio", dc_unit: "cm" });
  const id = await roomId(page);
  await page.goto(`/dc/${id}?view=3d&mode=schema`);
  await waitForRoom(page);

  const summary = page.getByTestId("room-summary");
  await expect(summary).toContainText("91устройств");
  await expect(summary).toContainText("у 69 из 91");
  await expect(summary.locator(".dc-summary-racks li")).toHaveCount(4);
  await expect(summary.locator(".dc-summary-racks li").nth(1).locator(".dc-warnmark svg")).toHaveCount(1);

  // A rack: four figures, its dimensions, open it on the racks page.
  await summary.locator(".dc-summary-racks button").nth(2).click();
  const rack = page.getByTestId("rack-summary");
  await expect(rack.locator(".dc-figure")).toHaveCount(4);
  await expect(rack).toContainText("занято");
  await expect(rack).toContainText("свободно подряд");
  await expect(rack).toContainText("без мощности");
  await expect(page.getByTestId("own-dims")).toContainText("204");
  await rack.getByRole("link", { name: "Открыть стойку" }).click();
  await expect(page).toHaveURL(/\/racks#obj-\d+$/);
  await expect(page.locator(".dc-rack-card[data-current]")).toContainText("Стойка 3");
});

test("racks page: four racks fit 1440 px, free runs, owner highlight, the device", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "light", dc_unit: "cm" });
  await page.goto(`/dc/${await roomId(page)}/racks`);
  const cards = page.getByTestId("rack-card");
  await expect(cards).toHaveCount(4);
  // Nothing to scroll sideways; every card fully in the window.
  expect(await page.locator(".dc-scroll").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  for (const c of await cards.all()) {
    const b = (await c.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(1440);
  }
  await expect(cards.first()).toContainText(/\d+\/42U/);
  await expect(page.locator(".dc-elev-free text").first()).toHaveText(/^\d+U свободно$/);
  await expect(cards.nth(1).locator(".dc-pill[data-tone=warn]")).toHaveText("сзади 55,5 см < 60");

  // A device: its card on the right; its owner highlights the others.
  await page.locator(".dc-elev-dev rect").first().click();
  const panel = page.getByTestId("device-panel");
  await expect(panel).toContainText("Мощность");
  await expect(panel.getByRole("link", { name: "Показать в 3D" })).toHaveAttribute("href", /#device-\d+$/);
  const owner = (await panel.locator(".dc-pill[data-tone=owner]").textContent())!;
  await panel.locator(".dc-pill[data-tone=owner]").click();
  await expect(page.locator(".dc-owner-chip")).toContainText(owner);
  expect(await page.locator('.dc-elev-dev[opacity="0.28"]').count()).toBeGreaterThan(0);
});

test("room list and history in words", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "light", dc_unit: "cm" });
  const id = await roomId(page);

  await page.goto("/dc");
  const card = page.getByTestId("room-card");
  await expect(card).toContainText("Серверная");
  await expect(card).toContainText("1 предупреждение");
  await expect(card.locator("svg.dc-miniplan rect[data-marked]")).toHaveCount(1);
  await expect(card).toContainText("Импорт CSV: 91 устройство");
  for (const name of ["Открыть в 3D", "План", "Стойки", "История"])
    await expect(card.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(page.locator(".dc-room-new")).toContainText("Появится вместе с конструктором комнат");
  await expect(page.locator(".dc-recent")).toContainText("Комната создана по замерам");

  await page.goto(`/dc/${id}/history`);
  const list = page.locator(".dc-revs");
  await expect(list).toContainText("Импорт CSV: 91 устройство");
  await expect(list).toContainText("Комната создана по замерам");
  await expect(page.locator(".dc-history")).not.toContainText("seed");
  await page.getByRole("radio", { name: "Импорт" }).click();
  await expect(list.locator("li")).toHaveCount(1);
  await page.getByRole("radio", { name: "Все" }).click();

  // The import's detail: plans before and after, the changes per rack.
  await list.getByRole("button", { name: /Импорт CSV/ }).click();
  const detail = page.locator(".dc-rev-detail");
  await expect(detail.locator("svg.dc-miniplan")).toHaveCount(2);
  await expect(detail).toContainText(/Изменения · \d+/);
  await expect(detail.locator(".dc-rev-changes li").first()).toContainText("Стойка 1");
  // The first revision: what the room was measured as; a restore note.
  await list.getByRole("button", { name: /Комната создана по замерам/ }).click();
  await expect(detail).toContainText("Восстановление создаёт новую ревизию");
  await detail.getByRole("link", { name: "Открыть в 3D на этой ревизии" }).click();
  await expect(page).toHaveURL(/rev=1/);
  await waitForRoom(page);
  await expect(page.locator(".dc-chips")).toContainText("Ревизия 1 — только просмотр");
});
