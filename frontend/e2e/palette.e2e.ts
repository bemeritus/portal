/**
 * The palette's find-free-space action (FEEDBACK-2 §4, FEEDBACK-3 §2): the
 * values come from the query and nothing is assumed. With parameters in the
 * query the row shows them at once and Enter runs; without a unit count the
 * row asks for one, and Enter or Tab opens the fields with units empty —
 * Enter is refused there until a whole number from 1 to 42 is entered. Esc
 * goes back to the list with the fields' values written into the query.
 */
import { expect, test, type Page } from "@playwright/test";

import { keepAccountAsFound, roomId, setLanguage, setSettings, signIn, waitForRoom } from "./helpers";

keepAccountAsFound();

async function openRoom(page: Page) {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio" });
  await page.goto(`/dc/${await roomId(page)}?view=3d`);
  await waitForRoom(page);
}

test("palette: parameters typed in the query fill the row and run", async ({ page }) => {
  await openRoom(page);
  const dialog = page.getByRole("dialog");
  const values = dialog.getByTestId("palette-values-space");

  await page.keyboard.press("Control+k");
  await page.keyboard.type("место 2u 0,8 квт");
  await expect(values).toHaveText("2U · 0,8 кВт");
  await expect(dialog.getByTestId("palette-missing-space")).toHaveCount(0);

  // Tab: the fields hold the query's values.
  await page.keyboard.press("Tab");
  await expect(dialog.getByLabel("Юнитов")).toHaveValue("2");
  await expect(dialog.getByLabel("Мощность, кВт")).toHaveValue("0,8");
  await expect(dialog.getByTestId("palette-space-values")).toHaveText("2U · 0,8 кВт");
  await dialog.getByLabel("Юнитов").fill("3");
  await dialog.getByLabel("Мощность, кВт").fill("1,5");

  // Esc: back to the list; the fields' values are in the query and the row.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox")).toHaveValue("место 3U 1,5 кВт");
  await expect(values).toHaveText("3U · 1,5 кВт");

  // Enter on the row runs with what it shows.
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#cap-u")).toHaveValue("3");
  await expect(page.locator("#cap-p")).toHaveValue("1500");

  // Uzbek and English words work too, in any order; empty power is "any".
  await page.keyboard.press("Control+k");
  await page.keyboard.type("4 yu joy");
  await expect(values).toHaveText("4U · мощность любая");
  await page.keyboard.press("Escape");
});

test("palette: without a unit count nothing is assumed", async ({ page }) => {
  await openRoom(page);
  const dialog = page.getByRole("dialog");
  const units = dialog.getByLabel("Юнитов");
  const power = dialog.getByLabel("Мощность, кВт");

  await page.keyboard.press("Control+k");
  await page.keyboard.type("свободно");
  await expect(dialog.getByTestId("palette-values-space")).toHaveCount(0);
  await expect(dialog.getByRole("option").first()).toContainText(
    "Найти свободное место — укажите юниты",
  );

  // Enter opens the fields (it cannot run): units empty and focused.
  await page.keyboard.press("Enter");
  await expect(dialog.getByTestId("palette-params")).toBeVisible();
  await expect(units).toBeFocused();
  await expect(units).toHaveValue("");
  await expect(power).toHaveValue("");
  await expect(units).not.toHaveAttribute("aria-invalid", "true");

  // Refused until a whole number from 1 to 42.
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(units).toHaveAttribute("aria-invalid", "true");
  await expect(units).toBeFocused();
  for (const bad of ["0", "43", "1,5"]) {
    await units.fill(bad);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(units).toHaveAttribute("aria-invalid", "true");
  }

  // Esc with nothing valid: back to the list, still asking.
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("combobox")).toHaveValue("свободно");
  await expect(dialog.getByTestId("palette-missing-space")).toBeVisible();

  // Tab works too; 2 units and an empty power ("any") run.
  await page.keyboard.press("Tab");
  await expect(units).toBeFocused();
  await units.fill("2");
  await expect(dialog.getByTestId("palette-space-values")).toHaveText("2U · мощность любая");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#cap-u")).toHaveValue("2");
  await expect(page.locator("#cap-p")).toHaveValue("");

  // A new opening starts from nothing again: no remembered values.
  await page.keyboard.press("Control+k");
  await page.keyboard.type("свободно");
  await expect(dialog.getByTestId("palette-missing-space")).toBeVisible();
});
