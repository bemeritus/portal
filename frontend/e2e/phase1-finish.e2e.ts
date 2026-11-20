/**
 * FEEDBACK-7: the last phase 1 pass — bugs, cameras, and a viewport that
 * works like a 3D tool. In order of the feedback's sections.
 */
import { expect, test, type Page } from "@playwright/test";

import {
  change,
  engine,
  keepAccountAsFound,
  pointAt,
  roomId,
  setLanguage,
  setSettings,
  signIn,
  waitForRoom,
  type Vec3,
} from "./helpers";

keepAccountAsFound();
test.describe.configure({ mode: "serial" });

interface Room {
  objects: { id: number; name: string; x0_mm: number; z0_mm: number; [k: string]: unknown }[];
  cells: { shelf_id: number; cell_no: number }[];
  analysis: {
    blocked_cells: Record<string, number[]>;
    cooling_over_cells: { object_id: number; cells: number[] }[];
  };
}

const getRoom = async (page: Page, id: number) =>
  (await (await page.request.get(`/api/dc/rooms/${id}`)).json()) as Room;

const labels = (page: Page) =>
  engine(page, (e) => (e as unknown as { labelsShown(): string[] }).labelsShown());

/** Drag on the canvas from one floor point to another (mm). */
async function dragFloor(page: Page, from: Vec3, to: Vec3) {
  const project = (p: Vec3) =>
    page.evaluate((q) => (window as unknown as { __dcEngine: { project(p: Vec3): [number, number] } }).__dcEngine.project(q), p);
  const [a, b] = [await project(from), await project(to)];
  const box = (await page.locator(".dc-viewport canvas").first().boundingBox())!;
  await page.mouse.move(box.x + a[0], box.y + a[1]);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++)
    await page.mouse.move(box.x + a[0] + ((b[0] - a[0]) * i) / 12, box.y + a[1] + ((b[1] - a[1]) * i) / 12);
  await page.mouse.up();
}

test("§1.1 a cooling unit moves over occupied cells, with a condensate pin", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio", dc_unit: "cm" });
  const id = await roomId(page);
  let room = await getRoom(page, id);
  const [shelfKey, blocked] = Object.entries(room.analysis.blocked_cells)[0];
  const shelf = Number(shelfKey);
  // Every free top-board cell holds equipment, so a unit moved sideways
  // comes over some of them.
  const free = Array.from({ length: 14 }, (_, i) => i + 1).filter(
    (n) => !blocked.includes(n) && !room.cells.some((c) => c.shelf_id === shelf && c.cell_no === n),
  );
  await change(
    page,
    id,
    free.map((n) => ({ op: "cell_set", cell: { shelf_id: shelf, cell_no: n, name: `tower ${n}` } })),
  );
  const k2 = room.objects.find((o) => o.name === "Кондиционер 2")!;
  try {
    await page.goto(`/dc/${id}?view=plan&mode=schema`);
    await waitForRoom(page);
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Правка" }).click();
    const b = (await engine(page, (e) => e.boxNamed("Кондиционер 2")))!;
    const c: Vec3 = [(b.min[0] + b.max[0]) / 2, 0, (b.min[2] + b.max[2]) / 2];
    await dragFloor(page, c, [c[0] - 300, 0, c[2]]);

    // Accepted: no refusal, the unit moved 300 mm toward the free cells
    // (give or take a snap).
    await expect(page.locator(".dc-chips")).not.toContainText("нельзя");
    await expect.poll(async () => (await getRoom(page, id)).objects.find((o) => o.id === k2.id)!.x0_mm - k2.x0_mm).toBeLessThan(-270);
    room = await getRoom(page, id);
    const warn = room.analysis.cooling_over_cells.find((w) => w.object_id === k2.id);
    expect(warn?.cells.length).toBeGreaterThan(0);
    // The pin under the unit, and the full text in the inspector.
    await expect.poll(async () => (await labels(page)).includes(`pin:${k2.id}:cooling`)).toBe(true);
    const pin = page.locator(`.dc-label[data-key="pin:${k2.id}:cooling"]`);
    await expect(pin).toHaveText(`над ячейками ${warn!.cells.join(", ")}`);
    await pin.click();
    await expect(page.getByTestId("condensate-warning")).toContainText(
      `Под кондиционером оборудование: ячейки ${warn!.cells.join(", ")} — риск конденсата`,
    );

    // A cell put into a blocked place is still refused.
    const under = room.analysis.blocked_cells[shelfKey].find((n) => !room.cells.some((x) => x.shelf_id === shelf && x.cell_no === n))!;
    await expect(change(page, id, [{ op: "cell_set", cell: { shelf_id: shelf, cell_no: under, name: "x" } }])).rejects.toThrow(
      /under a cooling unit/,
    );
  } finally {
    const { id: _k, ...fields } = k2;
    void _k;
    room = await getRoom(page, id);
    const ops: unknown[] = [{ op: "object_update", id: k2.id, object: fields }];
    for (const n of free) ops.unshift({ op: "cell_delete", shelf_id: shelf, cell_no: n });
    await change(page, id, ops);
  }
});

test("§3 a normal session asks for nothing that is not there (no 404)", async ({ page }) => {
  const missing: string[] = [];
  page.on("response", (r) => {
    if (r.status() === 404) missing.push(r.url());
  });
  page.on("console", (m) => {
    if (m.type() === "error" && /404/.test(m.text())) missing.push(`console: ${m.text()}`);
  });
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio", dc_unit: "cm" });
  const id = await roomId(page);
  await page.goto("/dc");
  await page.waitForLoadState("networkidle");
  await page.goto(`/dc/${id}?view=3d&mode=schema`);
  await waitForRoom(page);
  await page.goto(`/dc/${id}?view=plan`);
  await waitForRoom(page);
  await page.goto(`/dc/${id}/racks`);
  await page.waitForLoadState("networkidle");
  await page.goto(`/dc/${id}/history`);
  await page.waitForLoadState("networkidle");
  await page.goto(`/dc/${id}/history?rev=1`);
  await page.waitForLoadState("networkidle");
  await page.goto(`/dc/${id}?view=3d&mode=schema&rev=1`);
  await waitForRoom(page);
  await page.goto(`/dc/${id}/labels`);
  await page.waitForLoadState("networkidle");
  await page.goto("/dc/catalog");
  await page.waitForLoadState("networkidle");
  await page.goto("/dc/catalog/compare?ids=1,2");
  await page.waitForLoadState("networkidle");
  await page.goto("/dc/catalog/cooling");
  await page.waitForLoadState("networkidle");
  await page.locator('a[href*="/dc/catalog/item/"]').first().click();
  await page.waitForLoadState("networkidle");
  expect(missing).toEqual([]);
  // Headless Chromium never asks for a favicon; a desktop browser does, and
  // without an icon of its own the page made it ask for /favicon.ico (404).
  expect(await page.locator("link[rel=icon]").getAttribute("href")).toMatch(/^data:image\/svg\+xml,/);
});

interface Finish {
  drawnDimensions(): { key: string; layer: string }[];
  view(): { position: Vec3; target: Vec3 };
  boxNamed(name: string): { min: Vec3; max: Vec3 } | null;
  fadedIds(): number[];
}
const fin = <T>(page: Page, f: (e: Finish) => T) =>
  page.evaluate(`(${f.toString()})(window.__dcEngine)`) as Promise<T>;

async function setLayersStored(page: Page, layers: Record<string, boolean> | null) {
  await page.evaluate((l) => {
    if (l) localStorage.setItem("dc.layers", JSON.stringify(l));
    else localStorage.removeItem("dc.layers");
  }, layers);
}

test("§1.2 every dimension drawn belongs to a layer, and the layers decide them", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio", dc_unit: "cm" });
  const id = await roomId(page);
  await page.goto(`/dc/${id}?view=plan&mode=schema`);
  await waitForRoom(page);
  const layerNames = ["room", "chains", "gaps", "tape", "selection"];
  const all = Object.fromEntries(
    ["room", "chains", "gaps", "tape", "selection", "zones", "names", "lights", "assumptions"].map((k) => [k, true]),
  );
  await setLayersStored(page, all);
  await page.reload();
  await waitForRoom(page);
  const dims = await fin(page, (e) => e.drawnDimensions());
  expect(dims.length).toBeGreaterThan(10);
  for (const d of dims) expect(layerNames, d.key).toContain(d.layer);
  // «Зазоры между объектами» off: the outer chains stay — they are their own layer.
  await setLayersStored(page, { ...all, gaps: false });
  await page.reload();
  await waitForRoom(page);
  let shown = await fin(page, (e) => e.drawnDimensions());
  expect(shown.some((d) => d.layer === "chains")).toBe(true);
  expect(shown.some((d) => d.layer === "gaps")).toBe(false);
  // Chains off: none; the room's layer is its overall size only.
  await setLayersStored(page, { ...all, chains: false, gaps: false, tape: false });
  await page.reload();
  await waitForRoom(page);
  shown = await fin(page, (e) => e.drawnDimensions());
  expect(shown.filter((d) => d.layer !== "room")).toEqual([]);
  expect(shown.every((d) => d.key.startsWith("meas:room."))).toBe(true);
  // Every dimension layer off: no dimension at all.
  await setLayersStored(page, { ...all, room: false, chains: false, gaps: false, tape: false, selection: false });
  await page.reload();
  await waitForRoom(page);
  expect(await fin(page, (e) => e.drawnDimensions())).toEqual([]);
  await setLayersStored(page, null);
});

for (const width of [1440, 1920])
  test(`§1.3 no label is cut by a panel at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await setLanguage(page, "ru");
    await setSettings(page, { dc_theme: "studio", dc_unit: "cm" });
    const id = await roomId(page);
    const r3 = (await getRoom(page, id)).objects.find((o) => o.name === "Стойка 3")!.id;
    for (const url of [`/dc/${id}?view=plan&mode=schema`, `/dc/${id}?view=3d&mode=schema`, `/dc/${id}?view=3d&mode=schema#obj-${r3}`]) {
      await page.goto(url);
      await waitForRoom(page);
      await page.waitForTimeout(1500);
      const { labels, panels, view } = await page.evaluate(() => {
        const vp = document.querySelector(".dc-viewport")!.getBoundingClientRect();
        const box = (e: Element) => e.getBoundingClientRect().toJSON() as DOMRect;
        return {
          view: vp.toJSON() as DOMRect,
          labels: [...document.querySelectorAll<HTMLElement>(".dc-labels > div")]
            .filter((e) => e.style.display !== "none" && e.offsetWidth > 0)
            .map((e) => ({ ...box(e), text: e.textContent })),
          panels: [...document.querySelectorAll(".dc-viewport .dc-panel, .dc-viewport .dc-statusbar, .dc-viewport .dc-cube-wrap")]
            .map(box)
            .filter((b) => b.width > 0 && b.height > 0),
        };
      });
      expect(labels.length, url).toBeGreaterThan(3);
      for (const l of labels) {
        expect(l.left >= view.left - 1 && l.right <= view.right + 1 && l.top >= view.top - 1 && l.bottom <= view.bottom + 1, `«${l.text}» inside the view (${url})`).toBe(true);
        for (const p of panels) {
          const cut = l.left < p.right - 1 && p.left < l.right - 1 && l.top < p.bottom - 1 && p.top < l.bottom - 1;
          expect(cut, `«${l.text}» under a panel (${url})`).toBe(false);
        }
      }
    }
  });

test("§2.1 the default view looks at the racks' fronts, the cube says so", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio", dc_unit: "cm", dc_mode: null });
  const id = await roomId(page);
  await page.goto(`/dc/${id}?view=3d`);
  await waitForRoom(page);
  await page.waitForTimeout(1500);
  const { view, fronts } = await fin(page, (e) => ({
    view: e.view(),
    // The seeded racks' fronts face the shelf: −z.
    fronts: Math.min(...["Стойка 1", "Стойка 2", "Стойка 3", "Стойка 4"].map((n) => e.boxNamed(n)!.min[2])),
  }));
  // The camera is on the fronts' side, looking about 40° down.
  expect(view.position[2]).toBeLessThan(fronts);
  const [dx, dy, dz] = [0, 1, 2].map((i) => view.position[i] - view.target[i]);
  const down = (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
  expect(down).toBeGreaterThan(30);
  expect(down).toBeLessThan(50);
  // What stands in between (the shelf, the units) is faded.
  expect((await fin(page, (e) => e.fadedIds())).length).toBeGreaterThan(0);
  // The cube names the room's sides: its front face is «Фронт стоек».
  await expect(page.locator('.dc-cube-name[data-dc-face="front"]')).toHaveText("Фронт стоек");
  await expect(page.locator('.dc-cube-name[data-dc-face="front"]')).toBeVisible();
});

test("§4.2 the outliner and the view share the selection", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio", dc_unit: "cm" });
  const id = await roomId(page);
  const room = await getRoom(page, id);
  const idOf = (n: string) => room.objects.find((o) => o.name === n)!.id;
  await page.goto(`/dc/${id}?view=3d&mode=schema`);
  await waitForRoom(page);
  await page.locator("canvas").first().focus();
  await page.keyboard.press("o");
  const tree = page.getByTestId("outliner");
  await expect(tree).toBeVisible();
  // A row selects (and frames) its object.
  await tree.locator(`[data-key="o${idOf("Стойка 2")}"] .dc-outliner-name`).click();
  await expect(page).toHaveURL(new RegExp(`#obj-${idOf("Стойка 2")}$`));
  await expect(page.getByTestId("breadcrumb")).toContainText("Стойка 2");
  // A selection in the view highlights its row.
  const b = (await fin(page, (e) => e.boxNamed("Стойка 4")))!;
  await page.waitForTimeout(800);
  await pointAt(page, [(b.min[0] + b.max[0]) / 2, b.max[1] - 5, (b.min[2] + b.max[2]) / 2]);
  await expect(tree.locator(`[data-key="o${idOf("Стойка 4")}"]`)).toHaveAttribute("aria-selected", "true");
  // The search keeps the parents of what it finds.
  await tree.getByRole("textbox").fill("srv-0");
  await expect(tree.locator('[data-key^="d"]').first()).toBeVisible();
  await expect(tree.locator(`[data-key="o${idOf("Стойка 1")}"]`)).toBeVisible();
  await expect(tree.locator(`[data-key="o${idOf("Кондиционер 2")}"]`)).toHaveCount(0);
  await tree.getByRole("textbox").fill("");
  // The eye hides an object in the view, for this viewer.
  const r1 = idOf("Стойка 1");
  await tree.locator(`[data-key="o${r1}"]`).hover();
  await tree.locator(`[data-key="o${r1}"] .dc-outliner-actions button`).first().click();
  await expect.poll(async () => (await labels(page)).includes(`obj:${r1}:name`)).toBe(false);
  await page.evaluate((k) => localStorage.removeItem(k), `dc.hidden.${id}`);
});

test("§4.5 the keymap does nothing while typing", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio", dc_unit: "cm" });
  const id = await roomId(page);
  await page.goto(`/dc/${id}?view=3d&mode=schema`);
  await waitForRoom(page);
  await page.waitForTimeout(1200);
  const before = await fin(page, (e) => e.view());
  // Typed into the saved view's name: none of the keys acts.
  await page.locator(".dc-inspector").getByRole("tab", { name: "Виды" }).click();
  const name = page.getByRole("textbox", { name: "Название вида" });
  await name.click();
  await page.keyboard.type("O/7135F?LM.");
  await page.keyboard.press("Home");
  await expect(name).toHaveValue("O/7135F?LM.");
  await page.waitForTimeout(800);
  await expect(page.getByTestId("outliner")).toHaveCount(0);
  await expect(page.getByTestId("keymap")).toHaveCount(0);
  expect(await fin(page, (e) => e.view())).toEqual(before);
  // Outside the field the same keys act: `?` opens the keymap, `o` the outliner.
  await page.locator("canvas").first().focus();
  await page.keyboard.press("Shift+Slash");
  await expect(page.getByTestId("keymap")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("keymap")).toHaveCount(0);
  await page.keyboard.press("o");
  await expect(page.getByTestId("outliner")).toBeVisible();
  await page.keyboard.press("Numpad7");
  await expect.poll(async () => {
    const v = await fin(page, (e) => e.view());
    return Math.abs(v.position[0] - v.target[0]) + Math.abs(v.position[2] - v.target[2]) < 5;
  }).toBe(true);
});

test("§4.8 a tour of two saved views plays in order and ends on Esc", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio", dc_unit: "cm" });
  const id = await roomId(page);
  const view = (name: string, order: number, mode: string, position: Vec3) => ({
    op: "annotation_create",
    annotation: {
      kind: "view",
      payload: { name, position, target: [2700, 900, 2000], fov: 45, ortho: false, mode, shared: true, order, hold_s: 1, caption: `${name}: подпись` },
    },
  });
  await change(page, id, [view("Тур Б", 2, "fill", [6500, 3500, 800]), view("Тур А", 1, "schema", [2700, 3600, -2500])]);
  try {
    await page.goto(`/dc/${id}?view=3d&mode=realistic`);
    await waitForRoom(page);
    await page.locator(".dc-inspector").getByRole("tab", { name: "Виды" }).click();
    await page.getByTestId("tour-start").click();
    const tour = page.getByTestId("tour");
    // In order, with its caption, every panel hidden.
    await expect(tour).toContainText("Тур А");
    await expect(tour).toContainText("Тур А: подпись");
    await expect(page.locator(".dc-inspector")).toBeHidden();
    // The bar is hidden with every panel; its state still says the mode.
    const checked = page.locator('.dc-modebar [role=radio][aria-checked="true"]');
    await expect(checked).toHaveText("Схема");
    // 1.2 s of flight and 1 s of hold later, the second, in its own mode.
    await expect(tour).toContainText("Тур Б", { timeout: 6000 });
    await expect(checked).toHaveText("Заполнение");
    await page.keyboard.press("Escape");
    await expect(tour).toHaveCount(0);
    await expect(page.locator(".dc-inspector")).toBeVisible();
  } finally {
    const room = (await (await page.request.get(`/api/dc/rooms/${id}`)).json()) as {
      annotations: { id: number; kind: string; payload: { name?: string } }[];
    };
    const ours = room.annotations.filter((a) => a.kind === "view" && a.payload.name?.startsWith("Тур "));
    if (ours.length) await change(page, id, ours.map((a) => ({ op: "annotation_delete", id: a.id })));
  }
});
