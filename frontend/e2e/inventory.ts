/**
 * An example inventory for the seeded room, as the owner's CSV would be:
 * 96 devices in the four racks, 81 of them with a known power draw, three
 * owners. Deterministic, so screenshots and checks see the same room. It is
 * example data — the real inventory comes from the owner (FEEDBACK-6 §8).
 */
import type { Page } from "@playwright/test";

type Kind = "server" | "storage" | "switch" | "router" | "patch" | "ups" | "pdu" | "kvm" | "other";

/** Per rack, bottom up: [U height, kind, how many] blocks, with free Us between. */
const RACKS: Record<string, ([number, Kind, number] | number)[]> = {
  "Стойка 1": [[3, "ups", 1], 1, [2, "server", 4], [1, "server", 6], 2, [4, "storage", 1], [1, "switch", 2], [1, "patch", 2], 3, [1, "kvm", 1], [1, "server", 4]],
  "Стойка 2": [[2, "ups", 1], [2, "server", 5], 2, [1, "server", 7], [3, "storage", 1], 1, [1, "switch", 2], [1, "patch", 2], 4, [1, "router", 1], [1, "server", 6]],
  "Стойка 3": [[2, "ups", 1], 3, [2, "server", 3], [1, "server", 8], 2, [2, "storage", 2], [1, "switch", 2], [1, "patch", 1], [1, "server", 7], 2, [1, "other", 1]],
  "Стойка 4": [[2, "ups", 1], 4, [1, "server", 9], 7, [2, "storage", 1], 3, [1, "switch", 2], [1, "patch", 2], 2, [1, "router", 1], [1, "server", 4]],
};

const OWNERS = ["Eskiz", "ООО «Клиент-А»", "ООО «Клиент-Б»"];
const WATTS: Record<Kind, number> = {
  server: 450,
  storage: 620,
  switch: 120,
  router: 90,
  patch: 0,
  ups: 900,
  pdu: 0,
  kvm: 40,
  other: 150,
};
const NAME: Record<Kind, string> = {
  server: "srv",
  storage: "stor",
  switch: "sw",
  router: "rtr",
  patch: "patch",
  ups: "ups",
  pdu: "pdu",
  kvm: "kvm",
  other: "dev",
};

/** The CSV text (`;`, UTF-8 with a BOM, English headers). */
export function exampleInventory(): string {
  const rows = ["﻿room;rack;face;u_bottom;u_height;kind;name;owner;serial;power_w;power_src;status;note"];
  let n = 0;
  for (const [rack, blocks] of Object.entries(RACKS)) {
    let u = 1;
    for (const b of blocks) {
      if (typeof b === "number") {
        u += b;
        continue;
      }
      const [h, kind, count] = b;
      for (let i = 0; i < count; i++) {
        n++;
        // Every sixth active device has no known power: blank, never 0.
        const known = kind !== "patch" && n % 6 !== 0;
        const watts = known ? String(WATTS[kind] + (n % 4) * 10) : "";
        const src = known ? (n % 3 === 0 ? "measured" : "nameplate") : "";
        const owner = OWNERS[(n + (kind === "server" ? 1 : 0)) % OWNERS.length];
        rows.push(
          [
            "Серверная",
            rack,
            "front",
            u,
            h,
            kind,
            `${NAME[kind]}-${String(n).padStart(2, "0")}`,
            owner,
            `SN${(100000 + n * 7919).toString(36).toUpperCase()}`,
            watts,
            src,
            "active",
            "",
          ].join(";"),
        );
        u += h;
      }
    }
  }
  return rows.join("\r\n") + "\r\n";
}

/** Import the example inventory into a room (dry run, then for real). */
export async function importExample(page: Page, room: number): Promise<{ created: number; revision: number }> {
  const csrf = ((await (await page.request.get("/api/dc/csrf")).json()) as { token: string }).token;
  const headers = { "X-CSRF-Token": csrf, "content-type": "text/csv; charset=utf-8" };
  const csv = exampleInventory();
  const dry = await page.request.post(`/api/dc/rooms/${room}/import/devices?dry_run=true`, { data: csv, headers });
  if (!dry.ok()) throw new Error(`dry run: ${dry.status()} ${await dry.text()}`);
  const { revision } = (await dry.json()) as { revision: number };
  const r = await page.request.post(`/api/dc/rooms/${room}/import/devices?base_revision=${revision}`, {
    data: csv,
    headers,
  });
  if (!r.ok()) throw new Error(`import: ${r.status()} ${await r.text()}`);
  return (await r.json()) as { created: number; revision: number };
}
