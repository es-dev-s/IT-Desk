"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, floorsApi } from "@/lib/api";
import { autoNumber } from "@/lib/floors";
import type { FloorElement } from "@/lib/schemas";

export type Doc = { cols: number; rows: number; seatPrefix: string; elements: FloorElement[] };
export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";

type H = { doc: Doc | null; past: Doc[]; future: Doc[]; rev: number; stroke: boolean };
const LIMIT = 150;
const DEBOUNCE = 700;

/** Seats without a code get the next free one (row letter + number). */
const numbered = (d: Doc): Doc => ({ ...d, elements: autoNumber(d.seatPrefix, d.elements) });

/**
 * The builder's working copy: undo/redo history plus a debounced autosave of
 * the draft (optimistic concurrency on draftVersion; "conflict" when another
 * window saved first).
 */
export function useBuilderDoc(floorId: string) {
  const [h, setH] = useState<H>({ doc: null, past: [], future: [], rev: 0, stroke: false });
  const [save, setSave] = useState<{ state: SaveState; at: string | null; error?: string }>({ state: "idle", at: null });
  const [loadError, setLoadError] = useState<string | null>(null);
  const version = useRef(0);
  const docRef = useRef<Doc | null>(null);
  const savedRev = useRef(0);
  const revRef = useRef(0);
  const inFlight = useRef(false);
  const again = useRef(false);
  const conflicted = useRef(false);

  useEffect(() => {
    docRef.current = h.doc;
    revRef.current = h.rev;
  }, [h.doc, h.rev]);

  const load = useCallback(async () => {
    try {
      const d = await floorsApi.draft(floorId);
      version.current = d.draftVersion;
      savedRev.current = 0;
      conflicted.current = false;
      setH({ doc: { cols: d.cols, rows: d.rows, seatPrefix: d.seatPrefix, elements: d.elements }, past: [], future: [], rev: 0, stroke: false });
      setSave({ state: "saved", at: d.updatedAt });
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : "Couldn’t load this floor.");
    }
  }, [floorId]);
  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Apply a change. "step" = its own undo step; "stroke" = part of a drag that
   * undoes in one go (the first real change of the stroke takes the snapshot).
   */
  const change = useCallback((fn: (d: Doc) => Doc, kind: "step" | "stroke" = "step") => {
    setH((s) => {
      if (!s.doc) return s;
      const raw = fn(s.doc);
      if (raw === s.doc) return s;
      const snap = kind === "step" || !s.stroke;
      return {
        doc: numbered(raw),
        past: snap ? [...s.past.slice(-LIMIT + 1), s.doc] : s.past,
        future: snap ? [] : s.future,
        rev: s.rev + 1,
        stroke: kind === "stroke",
      };
    });
  }, []);
  const endStroke = useCallback(() => setH((s) => (s.stroke ? { ...s, stroke: false } : s)), []);
  const undo = useCallback(() => {
    setH((s) => {
      const prev = s.past.at(-1);
      if (!prev || !s.doc) return s;
      return { doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future], rev: s.rev + 1, stroke: false };
    });
  }, []);
  const redo = useCallback(() => {
    setH((s) => {
      const [next, ...rest] = s.future;
      if (!next || !s.doc) return s;
      return { doc: next, past: [...s.past, s.doc], future: rest, rev: s.rev + 1, stroke: false };
    });
  }, []);

  const flush = useCallback(async (): Promise<boolean> => {
    if (conflicted.current) return false;
    if (inFlight.current) {
      again.current = true;
      return false;
    }
    const doc = docRef.current;
    const rev = revRef.current;
    if (!doc || rev === savedRev.current) return true;
    inFlight.current = true;
    setSave((s) => ({ ...s, state: "saving" }));
    try {
      const d = await floorsApi.saveDraft(floorId, { ...doc, expectedDraftVersion: version.current });
      version.current = d.draftVersion;
      savedRev.current = rev;
      setSave({ state: revRef.current === rev ? "saved" : "dirty", at: d.updatedAt });
      return true;
    } catch (e) {
      const conflict = e instanceof ApiError && e.code === "stale_draft";
      conflicted.current = conflict;
      setSave((s) => ({ ...s, state: conflict ? "conflict" : "error", error: e instanceof ApiError ? e.message : "Couldn’t save" }));
      return false;
    } finally {
      inFlight.current = false;
      if (again.current) {
        again.current = false;
        if (revRef.current !== savedRev.current) void flush();
      }
    }
  }, [floorId]);

  useEffect(() => {
    if (h.rev === savedRev.current || !h.doc) return;
    setSave((s) => (s.state === "conflict" ? s : { ...s, state: "dirty" }));
    const t = window.setTimeout(() => {
      void flush();
    }, DEBOUNCE);
    return () => window.clearTimeout(t);
  }, [h.rev, h.doc, flush]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (revRef.current !== savedRev.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  return {
    doc: h.doc,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    change,
    endStroke,
    undo,
    redo,
    save,
    flush,
    reload: load,
    loadError,
    draftVersion: () => version.current,
    isClean: () => revRef.current === savedRev.current,
  };
}
