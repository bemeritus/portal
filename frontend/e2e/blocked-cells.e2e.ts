/**
 * FEEDBACK-2 §2: shelf cells under a cooling unit stay blocked, but in
 * Реалистичный they are shown as they are — the warning outline and hatch
 * appear only for the hovered or selected cell — while Схема keeps the red
 * fill. The inspector says why the cell is blocked.
 */
import { expect, test } from "@playwright/test";

import { engine, keepAccountAsFound, pointAt, roomId, setLanguage, setSettings, signIn, waitForRoom } from "./helpers";

keepAccountAsFound();

test("blocked cells: quiet in Реалистичный, marked on hover and selection", async ({ page }) => {
  await signIn(page);
  await setLanguage(page, "ru");
  await setSettings(page, { dc_theme: "studio" });
  const id = await roomId(page);
  const room = (await (await page.request.get(`/api/dc/rooms/${id}`)).json()) as {
    analysis: { blocked_cells: Record<string, number[]> };
  };
  const [shelf, cells] = Object.entries(room.analysis.blocked_cells)[0];
  const cell = cells[0];
  expect(cells.length).toBeGreaterThan(0);

  // Selected through a deep link: only its mark shows, and the inspector
  // explains it.
  await page.goto(`/dc/${id}?view=3d&mode=realistic#cell-${shelf}-${cell}`);
  await waitForRoom(page);
  await expect(page.getByTestId("cell-blocked")).toHaveText(/под кондиционером, занимать нельзя/);
  await expect
    .poll(() => engine(page, (e) => e.blockedMarks().filter((m) => m.shown).map((m) => m.cellNo)))
    .toEqual([cell]);
  const marks = await engine(page, (e) => e.blockedMarks());
  expect(marks.map((m) => m.cellNo).sort((a, b) => a - b)).toEqual([...cells].sort((a, b) => a - b));

  // Nothing selected: no mark at all.
  await page.goto(`/dc/${id}?view=3d&mode=realistic`);
  await waitForRoom(page);
  expect(await engine(page, (e) => e.blockedMarks().filter((m) => m.shown).length)).toBe(0);

  // Hover: the mark of the cell under the pointer, gone when it leaves.
  const target = marks.find((m) => m.cellNo === cell)!;
  // In front of the cell, as a double-click would put the camera.
  await page.evaluate(
    ([s, n]) =>
      (window as unknown as { __dcEngine: { flyTo(r: unknown): void } }).__dcEngine.flyTo({
        type: "cell",
        shelfId: s,
        cellNo: n,
      }),
    [Number(shelf), cell],
  );
  await page.waitForTimeout(1500);
  await pointAt(page, target.centre, false);
  await expect
    .poll(() => engine(page, (e) => e.blockedMarks().filter((m) => m.shown).map((m) => m.cellNo)))
    .toEqual([cell]);
  await page.mouse.move(5, 5);
  await expect
    .poll(() => engine(page, (e) => e.blockedMarks().filter((m) => m.shown).length))
    .toBe(0);

  // Схема: the red fill instead, no marks.
  await page.goto(`/dc/${id}?view=3d`);
  await waitForRoom(page);
  expect(await engine(page, (e) => e.blockedMarks().length)).toBe(0);
});
