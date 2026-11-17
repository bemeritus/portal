/**
 * Data for the room page: the room query with revision polling, and change
 * sets with conflict recovery and the user's own undo/redo (SPEC §7, §8).
 *
 * Undo never rewinds anyone else's work: each entry holds the *inverse
 * operations* of one of this session's change sets, computed from the data
 * the user saw, and undoing sends them as a new change set. Ids a re-create
 * gets from the server are remapped, so undo → redo → undo keeps working.
 *
 * On 409 (the room moved on) the room is refetched; if the pending operations
 * still make sense against the new state they are re-applied once, otherwise
 * the caller is told and the user decides — forms keep their input.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../api/client";
import { dcApi } from "./api";
import { unitsFree } from "./model/devices";
import type { Applied, Clearance, Op, RoomData } from "./types";

const POLL_MS = 15_000;

export function useRoom(roomId: number) {
  const qc = useQueryClient();
  const room = useQuery({
    queryKey: ["dc", "room", roomId],
    queryFn: ({ signal }) => dcApi.room(roomId, signal),
  });
  const revision = room.data?.room.revision;
  // Poll the cheap revision endpoint while the page is visible.
  useQuery({
    queryKey: ["dc", "head", roomId],
    queryFn: async ({ signal }) => {
      const head = await dcApi.head(roomId, signal);
      if (revision !== undefined && head.revision !== revision) {
        await qc.invalidateQueries({ queryKey: ["dc", "room", roomId] });
      }
      return head;
    },
    enabled: revision !== undefined,
    refetchInterval: () => (document.visibilityState === "visible" ? POLL_MS : false),
    refetchIntervalInBackground: false,
  });
  return room;
}

// --- Inverses ----------------------------------------------------------------------

type Kind = "object" | "device" | "annotation";

/** An inverse that re-creates a deleted thing remembers the id it replaces. */
type TaggedOp = Op & { replaces?: { kind: Kind; id: number } };

/** The operations that undo `ops`, given the state before them; created ids
 *  are filled in after the forward set has run. */
function inverseOf(ops: Op[], before: RoomData): (created: (number | null)[]) => TaggedOp[] {
  return (created) => {
    const inv: TaggedOp[] = [];
    ops.forEach((op, i) => {
      switch (op.op) {
        case "object_update": {
          const o = before.objects.find((x) => x.id === op.id);
          if (o) {
            const { id, ...fields } = o;
            inv.push({ op: "object_update", id, object: fields });
          }
          break;
        }
        case "object_create":
          if (created[i] !== null) inv.push({ op: "object_delete", id: created[i]! });
          break;
        case "object_delete": {
          const o = before.objects.find((x) => x.id === op.id);
          if (o) {
            const { id, ...fields } = o;
            inv.push({ op: "object_create", object: fields, replaces: { kind: "object", id } });
          }
          break;
        }
        case "device_create":
          if (created[i] !== null) inv.push({ op: "device_delete", id: created[i]! });
          break;
        case "device_update": {
          const d = before.devices.find((x) => x.id === op.id);
          if (d) {
            const { id, ...fields } = d;
            inv.push({ op: "device_update", id, device: fields });
          }
          break;
        }
        case "device_delete": {
          const d = before.devices.find((x) => x.id === op.id);
          if (d) {
            const { id, ...fields } = d;
            inv.push({ op: "device_create", device: fields, replaces: { kind: "device", id } });
          }
          break;
        }
        case "cell_set": {
          const c = before.cells.find((x) => x.shelf_id === op.cell.shelf_id && x.cell_no === op.cell.cell_no);
          inv.push(c ? { op: "cell_set", cell: c } : { op: "cell_delete", shelf_id: op.cell.shelf_id, cell_no: op.cell.cell_no });
          break;
        }
        case "cell_delete": {
          const c = before.cells.find((x) => x.shelf_id === op.shelf_id && x.cell_no === op.cell_no);
          if (c) inv.push({ op: "cell_set", cell: c });
          break;
        }
        case "annotation_create":
          if (created[i] !== null) inv.push({ op: "annotation_delete", id: created[i]! });
          break;
        case "annotation_delete": {
          const a = before.annotations.find((x) => x.id === op.id);
          if (a)
            inv.push({
              op: "annotation_create",
              annotation: a.kind === "note" ? { kind: "note", payload: a.payload } : { kind: "view", payload: a.payload },
              replaces: { kind: "annotation", id: a.id },
            });
          break;
        }
      }
    });
    // Undo in reverse order: a device moved into a rack whose contents were
    // just marked recorded must leave before the mark is taken back.
    return inv.reverse();
  };
}

/** Does `op` still make sense against `data` (after someone else's change)? */
export function stillValid(op: Op, data: RoomData): boolean {
  const hasObject = (id: number) => data.objects.some((o) => o.id === id);
  const hasDevice = (id: number) => data.devices.some((d) => d.id === id);
  switch (op.op) {
    case "object_update":
    case "object_delete":
      return hasObject(op.id);
    case "device_update":
    case "device_create": {
      const dev = op.device;
      if (!hasObject(dev.rack_id)) return false;
      if (op.op === "device_update" && !hasDevice(op.id)) return false;
      const rack = data.objects.find((o) => o.id === dev.rack_id)!;
      const item = data.catalog.find((c) => c.id === rack.catalog_id);
      if (!item || item.kind !== "rack") return false;
      const devs = data.devices.filter((d) => d.rack_id === dev.rack_id);
      return unitsFree(devs, item.props.units, dev.u_bottom, dev.u_height, dev.face, op.op === "device_update" ? op.id : undefined);
    }
    case "device_delete":
      return hasDevice(op.id);
    case "cell_set":
      return hasObject(op.cell.shelf_id);
    case "cell_delete":
      return data.cells.some((c) => c.shelf_id === op.shelf_id && c.cell_no === op.cell_no);
    case "annotation_delete":
      return data.annotations.some((a) => a.id === op.id);
    default:
      return true;
  }
}

// --- Change sets ----------------------------------------------------------------------

interface Entry {
  label: string;
  forward: TaggedOp[];
  inverse: TaggedOp[];
}

export type ChangeResult =
  | { ok: true; applied: Applied }
  /** Someone else changed the room and this edit no longer fits; nothing was saved. */
  | { ok: false; conflict: true; error: string }
  | { ok: false; conflict: false; error: string };

export function useChanges(roomId: number, data: RoomData | undefined) {
  const qc = useQueryClient();
  const undoStack = useRef<Entry[]>([]);
  const redoStack = useRef<Entry[]>([]);
  /** Old id → new id, per kind, for things undo re-created. */
  const ids = useRef(new Map<string, number>());
  const [pending, setPending] = useState(false);
  const [warnings, setWarnings] = useState<Clearance[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [, bump] = useState(0);
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const resolve = (kind: Kind, id: number) => {
    let cur = id;
    for (let i = 0; i < 20; i++) {
      const next = ids.current.get(`${kind}:${cur}`);
      if (next === undefined) return cur;
      cur = next;
    }
    return cur;
  };

  /** Rewrite ids through the remap table. */
  const remap = useCallback((op: TaggedOp): TaggedOp => {
    switch (op.op) {
      case "object_update":
      case "object_delete":
        return { ...op, id: resolve("object", op.id) };
      case "device_update":
        return { ...op, id: resolve("device", op.id), device: { ...op.device, rack_id: resolve("object", op.device.rack_id) } };
      case "device_create":
        return { ...op, device: { ...op.device, rack_id: resolve("object", op.device.rack_id) } };
      case "device_delete":
        return { ...op, id: resolve("device", op.id) };
      case "cell_set":
        return { ...op, cell: { ...op.cell, shelf_id: resolve("object", op.cell.shelf_id) } };
      case "cell_delete":
        return { ...op, shelf_id: resolve("object", op.shelf_id) };
      case "annotation_delete":
        return { ...op, id: resolve("annotation", op.id) };
      default:
        return op;
    }
  }, []);

  const refresh = useCallback(async (): Promise<RoomData> => {
    await qc.invalidateQueries({ queryKey: ["dc", "room", roomId] });
    return qc.fetchQuery({ queryKey: ["dc", "room", roomId], queryFn: () => dcApi.room(roomId) });
  }, [qc, roomId]);

  /** Send ops; one automatic retry after a 409 if they still fit. */
  const send = useCallback(
    async (ops: TaggedOp[], summary: string): Promise<{ applied: Applied; before: RoomData } | ChangeResult> => {
      let current = dataRef.current;
      if (!current) return { ok: false, conflict: false, error: "Room not found" };
      const strip = (o: TaggedOp): Op => {
        const copy = { ...o };
        delete copy.replaces;
        return copy as Op;
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const mapped = ops.map(remap);
        try {
          const applied = await dcApi.changes(roomId, current.room.revision, mapped.map(strip), summary);
          mapped.forEach((op, i) => {
            const id = applied.created[i];
            if (op.replaces && id !== null && id !== undefined) ids.current.set(`${op.replaces.kind}:${op.replaces.id}`, id);
          });
          return { applied, before: current };
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && typeof e.body.revision === "number") {
            current = await refresh();
            dataRef.current = current;
            if (attempt === 0 && mapped.every((op) => stillValid(op, current!))) {
              setNotice("dc.conflict.reapplied");
              continue;
            }
            return { ok: false, conflict: true, error: e.message };
          }
          return { ok: false, conflict: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      return { ok: false, conflict: true, error: "" };
    },
    [refresh, remap, roomId],
  );

  const finish = useCallback(
    async (applied: Applied) => {
      setWarnings(applied.warnings);
      await qc.invalidateQueries({ queryKey: ["dc", "room", roomId] });
      await qc.invalidateQueries({ queryKey: ["dc", "revisions", roomId] });
    },
    [qc, roomId],
  );

  /** Apply ops as one change set and push it on the undo stack. */
  const apply = useCallback(
    async (ops: Op[], label: string): Promise<ChangeResult> => {
      setPending(true);
      setNotice(null);
      try {
        const r = await send(ops, label);
        if ("ok" in r) return r;
        const inverse = inverseOf(ops, r.before)(r.applied.created);
        undoStack.current.push({ label, forward: ops.map((op, i) => withCreated(op, r.applied.created[i])), inverse });
        redoStack.current = [];
        await finish(r.applied);
        bump((n) => n + 1);
        return { ok: true, applied: r.applied };
      } finally {
        setPending(false);
      }
    },
    [finish, send],
  );

  const travel = useCallback(
    async (dir: "undo" | "redo"): Promise<ChangeResult | null> => {
      const from = dir === "undo" ? undoStack.current : redoStack.current;
      const to = dir === "undo" ? redoStack.current : undoStack.current;
      const entry = from.pop();
      if (!entry) return null;
      setPending(true);
      try {
        const ops = dir === "undo" ? entry.inverse : entry.forward;
        const r = await send(ops, `${dir}: ${entry.label}`);
        if ("ok" in r) {
          from.push(entry);
          return r;
        }
        to.push(entry);
        await finish(r.applied);
        bump((n) => n + 1);
        return { ok: true, applied: r.applied };
      } finally {
        setPending(false);
      }
    },
    [finish, send],
  );

  return {
    apply,
    undo: () => travel("undo"),
    redo: () => travel("redo"),
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    undoLabel: undoStack.current.at(-1)?.label ?? null,
    redoLabel: redoStack.current.at(-1)?.label ?? null,
    pending,
    warnings,
    notice,
    clearNotice: () => setNotice(null),
    refresh,
  };
}

/**
 * A forward create, for redo: tagged with the id it made, so after an undo
 * deleted it and a redo re-creates it, the new id replaces the old one.
 */
function withCreated(op: Op, created: number | null | undefined): TaggedOp {
  if (created === null || created === undefined) return op;
  if (op.op === "object_create") return { ...op, replaces: { kind: "object", id: created } };
  if (op.op === "device_create") return { ...op, replaces: { kind: "device", id: created } };
  if (op.op === "annotation_create") return { ...op, replaces: { kind: "annotation", id: created } };
  return op;
}
