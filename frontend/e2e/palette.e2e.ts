/**
 * FEEDBACK-2 §4: «Найти свободное место» in the command palette shows its
 * values in the row; Tab (or →) opens its fields, Enter runs, Esc goes back
 * to the list with the values kept.
 */
import { expect, test } from "@playwright/test";

import { keepAccountAsFound, roomId, setLanguage, setSettings, signIn, waitForRoom } from "./helpers";

keepAccountAsFound();

test("palette: Tab → edit → Enter, Esc back to the list", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio" });
  await page.goto(`/dc/${await roomId(page)}?view=3d`);
  await waitForRoom(page);

  const dialog = page.getByRole("dialog");
  const values = dialog.getByTestId("palette-values-space");
  const fields = dialog.getByTestId("palette-params");
  const units = dialog.getByLabel("Юнитов");
  const power = dialog.getByLabel("Мощность, кВт");

  await page.keyboard.press("Control+k");
  await page.keyboard.type("свобод");
  // The current values are in the row from the start.
  await expect(values).toHaveText("1U · мощность любая");

  // Tab: the fields, with those values.
  await page.keyboard.press("Tab");
  await expect(fields).toBeVisible();
  await expect(units).toBeFocused();
  await expect(units).toHaveValue("1");
  await expect(power).toHaveValue("");
  await page.keyboard.type("2");
  await page.keyboard.press("Tab");
  await expect(power).toBeFocused();
  await page.keyboard.type("0,8");
  await expect(dialog.getByTestId("palette-space-values")).toHaveText("2U · 0,8 кВт");

  // Esc: back to the list, still open, the query and the values kept.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(fields).toBeHidden();
  await expect(dialog.getByRole("combobox")).toHaveValue("свобод");
  await expect(values).toHaveText("2U · 0,8 кВт");

  // → at the end of the query opens them too; a bad value does not run.
  await page.keyboard.press("ArrowRight");
  await expect(units).toHaveValue("2");
  await expect(power).toHaveValue("0,8");
  await power.fill("abc");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(power).toHaveAttribute("aria-invalid", "true");
  await power.fill("1,5");
  await units.fill("3");

  // Enter runs: the capacity finder opens with these values.
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#cap-u")).toHaveValue("3");
  await expect(page.locator("#cap-p")).toHaveValue("1500");

  // Enter on the row runs with the values it shows, without the fields.
  await page.keyboard.press("Control+k");
  await page.keyboard.type("свобод 4U");
  await expect(values).toHaveText("4U · мощность любая");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#cap-u")).toHaveValue("4");
  await expect(page.locator("#cap-p")).toHaveValue("");
});
