/**
 * FEEDBACK-4: the catalog section. Sizes in the user's unit, the item page
 * by URL (dimensions, airflow, sources), the table sorting, a rendered
 * picture on every card, filters in the URL changing the count, and a
 * comparison of two items.
 */
import { expect, test, type Page } from "@playwright/test";

import { keepAccountAsFound, setLanguage, setSettings, signIn } from "./helpers";

keepAccountAsFound();

/** Intl groups thousands with a no-break space in Russian. */
const norm = (s: string | null) => (s ?? "").replace(/[  ]/g, " ").trim();

async function catalogIds(page: Page) {
  const xs = (await (await page.request.get("/api/dc/catalog")).json()) as {
    id: number;
    model: string;
  }[];
  return (prefix: string) => xs.find((x) => x.model.startsWith(prefix))!.id;
}

async function open(page: Page, path: string) {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "light", dc_unit: "cm" });
  await page.goto(path);
}

const card = (page: Page, name: string) =>
  page.getByTestId("catalog-card").filter({ has: page.getByRole("link", { name: new RegExp(`^Открыть ${name}`) }) });

test("card sizes in cm, mm and m", async ({ page }) => {
  await open(page, "/dc/catalog/cooling");
  const dims = card(page, "Liebert CRV CRD25").getByTestId("card-dims");
  await expect(dims).toHaveText("30 × 113,2 × 200");
  await expect(card(page, "Liebert CRV CRD25")).toContainText("Ш × Г × В, см");
  const unit = page.locator(".dc-top").getByRole("radiogroup").first();
  await unit.getByRole("radio", { name: "мм", exact: true }).click();
  await expect.poll(async () => norm(await dims.textContent())).toBe("300 × 1 132 × 2 000");
  await unit.getByRole("radio", { name: "м", exact: true }).click();
  await expect.poll(async () => norm(await dims.textContent())).toBe("0,3 × 1,132 × 2");
});

test("the item page opens by URL with dimensions, airflow and sources", async ({ page }) => {
  await open(page, "/dc/catalog/cooling");
  const id = (await catalogIds(page))("Liebert CRV CRD25");
  await page.goto(`/dc/catalog/item/${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Liebert CRV CRD25");
  // Dimensions in the viewer, in the user's unit.
  const chips = page.locator(".dc-viewer-host .dc-label-dim");
  await expect.poll(async () => (await chips.allTextContents()).map(norm).sort()).toEqual([
    "113,2 см",
    "200 см",
    "30 см",
  ]);
  // Airflow: the legend names the faces.
  await expect(page.getByTestId("air-legend")).toContainText("подача холодного, спереди");
  await expect(page.getByTestId("air-legend")).toContainText("забор горячего, сзади");
  // Every published value carries its source; conditions under the capacity.
  const sensible = page.getByTestId("spec-cooling_sensible_w");
  await expect(sensible).toContainText("25 кВт");
  await expect(sensible).toContainText("при ");
  await expect(sensible.locator("a.dc-src")).toHaveAttribute("href", /vertiv\.com/);
  // Unknown is "no data" with why, never 0 or empty.
  await expect(page.getByTestId("spec-cooling_total_w")).toContainText("нет данных");
  await expect(page.getByText("Пока ни в одной комнате.")).toBeVisible();
  // No stick figure; the rack for scale is off until asked for.
  await expect(page.locator(".dc-viewer-host .dc-label-name")).toHaveCount(0);
  await page.getByRole("button", { name: "Стойка 42U рядом" }).click();
  await expect(page.locator(".dc-viewer-host .dc-label-name")).toHaveText("Стойка 42U");
});

test("the table sorts by its columns", async ({ page }) => {
  await open(page, "/dc/catalog/cooling?view=table");
  const table = page.getByTestId("catalog-table");
  const column = async (n: number) =>
    (await table.locator(`tbody tr td:nth-child(${n})`).allTextContents()).map((s) =>
      Number(norm(s).replace(/[^\d,]/g, "").replace(",", ".")),
    );
  // Airflow is the 5th column; unknown ("—") reads as 0 and sorts last.
  await table.getByRole("button", { name: "Воздух, м³/ч" }).click();
  await expect(page).toHaveURL(/sort=air/);
  await expect.poll(async () => {
    const v = await column(5);
    return v.join() === [...v].sort((a, b) => b - a).join();
  }).toBe(true);
  await table.getByRole("button", { name: "Воздух, м³/ч" }).click();
  await expect(page).toHaveURL(/dir=asc/);
  await expect.poll(async () => {
    const v = (await column(5)).filter((x) => x > 0);
    return v.join() === [...v].sort((a, b) => a - b).join();
  }).toBe(true);
  await expect(page).toHaveURL(/sort=air/);
  await expect(page).toHaveURL(/dir=asc/);
});

test("every card has a rendered picture", async ({ page }) => {
  await open(page, "/dc/catalog/cooling");
  const t0 = Date.now();
  const cards = page.getByTestId("catalog-card");
  await expect(cards).toHaveCount(21);
  await expect(page.locator("img[data-thumb]")).toHaveCount(21, { timeout: 30_000 });
  console.log(`21 card pictures in ${Date.now() - t0} ms (this machine, headless)`);
  // Not a blank canvas: the pixels vary.
  const variances = await page.locator("img[data-thumb]").evaluateAll(async (imgs) =>
    Promise.all(
      (imgs as HTMLImageElement[]).map(async (img) => {
        await img.decode();
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 48;
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0, 64, 48);
        const d = g.getImageData(0, 0, 64, 48).data;
        let sum = 0,
          sq = 0;
        const n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
          const l = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
          sum += l;
          sq += l * l;
        }
        return sq / n - (sum / n) ** 2;
      }),
    ),
  );
  for (const v of variances) expect(v).toBeGreaterThan(50);
});

test("filters change the count and live in the URL", async ({ page }) => {
  await open(page, "/dc/catalog/cooling");
  const count = page.getByTestId("catalog-count");
  await expect(count).toHaveText("Показано 21 из 21");
  await page.getByLabel("Только 24/7").click();
  await expect(count).toHaveText("Показано 4 из 21");
  await expect(page.getByTestId("catalog-card")).toHaveCount(4);
  await expect(page).toHaveURL(/h247=1/);
  // A shared link opens the same list.
  await page.reload();
  await expect(count).toHaveText("Показано 4 из 21");
  await page.getByRole("radio", { name: "Комфортные" }).click();
  await expect(count).toHaveText("Показано 0 из 21");
  await page.getByRole("button", { name: "Сбросить фильтры" }).click();
  await expect(count).toHaveText("Показано 21 из 21");
  // A maker unticked.
  await page.getByLabel("Gree").click();
  await expect(count).toHaveText("Показано 16 из 21");
  await expect(page).toHaveURL(/brand_off=Gree/);
});

test("compare two items", async ({ page }) => {
  await open(page, "/dc/catalog/cooling");
  await card(page, "Liebert CRV CRD25").getByRole("button", { name: /к сравнению/ }).click();
  await card(page, "Liebert CRV CRD35").getByRole("button", { name: /к сравнению/ }).click();
  const tray = page.getByRole("region", { name: "Сравнение" });
  await expect(tray).toContainText("CRV CRD25");
  await expect(tray).toContainText("CRV CRD35");
  await tray.getByRole("button", { name: "Сравнить" }).click();
  await expect(page).toHaveURL(/\/dc\/catalog\/compare\?ids=\d+,\d+/);
  const table = page.getByTestId("compare-table");
  await expect(table.locator("thead th")).toHaveCount(3);
  // The rows that differ are marked; the ones that agree are not.
  const sensible = table.locator("tbody tr", { hasText: "Явная холодопроизводительность" });
  await expect(sensible).toHaveAttribute("data-differs", "true");
  const faces = table.locator("tbody tr", { hasText: "Подача / забор" });
  await expect(faces).not.toHaveAttribute("data-differs", "true");
});
