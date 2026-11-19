/**
 * FEEDBACK-5 §5: notes written by the seed in every UI language show in the
 * user's; English when the language is not one of them; a note as typed is
 * shown as typed.
 */

import { describe, expect, it } from "vitest";

import { localText } from "./types";

const note = { en: "open frame", ru: "открытая рама", uz: "ochiq rama" };

describe("localText", () => {
  it("shows the user's language", () => {
    expect(localText(note, "ru")).toBe("открытая рама");
    expect(localText(note, "uz-Latn")).toBe("ochiq rama");
    expect(localText(note, "en")).toBe("open frame");
  });

  it("falls back to English", () => {
    expect(localText(note, "de")).toBe("open frame");
    expect(localText({ ...note, uz: "" }, "uz")).toBe("open frame");
  });

  it("shows a typed note as typed", () => {
    expect(localText("как есть", "uz")).toBe("как есть");
  });
});
