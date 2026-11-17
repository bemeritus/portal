/**
 * Which renderer draws which catalog kind. Phase 2 kinds (UPS, PDU, panels,
 * raised floor, sensors) are added here, one line each.
 */

import type { Kind } from "../../types";
import { coolingRenderer } from "./cooling";
import { rackRenderer } from "./rack";
import { shelfRenderer } from "./shelf";
import { structureRenderer } from "./structure";
import { trayRenderer } from "./tray";
import type { ObjectRenderer } from "./types";

export const RENDERERS: Record<Kind, ObjectRenderer> = {
  rack: rackRenderer,
  shelf: shelfRenderer,
  cooling: coolingRenderer,
  structure: structureRenderer,
  cable_tray: trayRenderer,
};
