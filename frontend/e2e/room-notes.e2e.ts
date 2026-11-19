/**
 * FEEDBACK-5 §5, follow-up: the room's own notes — the plan's dimension
 * tooltips, what to re-measure, what is not modelled, conflicts, object
 * notes — are in the user's language; no English in the RU or UZ UI.
 */
import { expect, test, type Page } from "@playwright/test";

import { keepAccountAsFound, roomId, setLanguage, setSettings, signIn, waitForRoom, type Lang } from "./helpers";

keepAccountAsFound();

/** Seed texts in English that must not show in Russian or Uzbek. */
const ENGLISH = ["re-measuring", "not modelled", "photos", "drawn along", "power chain", "open frame", "the wall", "finish"];

const SEEN: Record<Lang, { remeasure: string; notModelled: string; rack1: string; tooltip: string }> = {
  ru: {
    remeasure: "стойка 2: зазор от задней стороны до стены (модель и рулетка расходятся на 30 мм)",
    notModelled: "цепь питания: неизвестна",
    rack1: "открытая рама (фото 03, 08)",
    tooltip: "Стойки поставлены по измеренному проходу от стеллажа.",
  },
  uz: {
    remeasure: "2-stoyka: orqa tomondan devorgacha oraliq (model va ruletka 30 mm farq qiladi)",
    notModelled: "elektr ta'minoti zanjiri: noma'lum",
    rack1: "ochiq rama (foto 03, 08)",
    tooltip: "Stoykalar stellajdan o'lchangan o'tish joyi bo'yicha qo'yilgan.",
  },
  en: {
    remeasure: "r2: gap from back to wall (model and tape differ by 30 mm)",
    notModelled: "power chain: unknown",
    rack1: "open frame (photos 03, 08)",
    tooltip: "Racks are placed by the measured aisle from the shelf.",
  },
};

/** Open an inspector tab, from the row or from «⋯». */
async function openTab(page: Page, index: number) {
  const insp = page.locator(".dc-inspector");
  const tabs = insp.locator('[role="tablist"] [role="tab"]');
  if ((await tabs.count()) > index) await tabs.nth(index).click();
  else {
    await insp.locator("button.dc-tab-more").click();
    await page.getByRole("menuitem").nth(index - (await tabs.count())).click();
  }
}

for (const lang of ["ru", "uz", "en"] as const)
  test(`room notes in ${lang}`, async ({ page }) => {
    await signIn(page);
    await setLanguage(page, lang);
    await setSettings(page, { dc_theme: "studio", dc_unit: "mm" });
    const id = await roomId(page);
    const room = (await (await page.request.get(`/api/dc/rooms/${id}`)).json()) as {
      objects: { id: number; name: string }[];
    };
    const r1 = room.objects.find((o) => o.name === "Стойка 1")!.id;

    // The plan's tooltip on rack 1's back gap: a tape dimension, drawn
    // with the «Все замеры рулеткой» layer on (FEEDBACK-6 §1).
    await page.addInitScript(() => localStorage.setItem("dc.layers", JSON.stringify({ tape: true })));
    await page.goto(`/dc/${id}?view=plan&mode=schema`);
    await waitForRoom(page);
    const marked = page.locator(".dc-labels .dc-label-mark");
    await expect.poll(async () => (await marked.evaluateAll((els) => els.map((e) => e.title))).join("\n")).toContain(
      SEEN[lang].tooltip,
    );

    // The measurements tab: what to re-measure, what is not modelled.
    await page.goto(`/dc/${id}?view=3d`);
    await waitForRoom(page);
    await openTab(page, 2);
    const insp = page.locator(".dc-inspector");
    await expect(insp).toContainText(SEEN[lang].remeasure);
    await expect(insp).toContainText(SEEN[lang].notModelled);
    if (lang !== "en") for (const w of ENGLISH) await expect(insp).not.toContainText(w);
    // Russian has no Latin words at all, but for the objects' own names.
    if (lang === "ru") {
      const names = room.objects.map((o) => o.name).join(" ");
      const latin = ((await insp.innerText()).match(/\b[A-Za-z][a-z]{3,}\b/g) ?? []).filter(
        (w) => !names.includes(w),
      );
      expect(latin).toEqual([]);
    }

    // An object's note, shown and in its edit field.
    await page.evaluate((n) => (window.location.hash = `#obj-${n}`), r1);
    await expect(insp).toContainText(SEEN[lang].rack1);
  });
