/**
 * Server-anchored clock. The API returns its current time with every workspace
 * snapshot; we keep the offset so "today", relative dates and analytics follow
 * the server, not a possibly-skewed laptop clock. Only read from effects,
 * event handlers or client-only render paths (the workspace is client-loaded).
 */
let offsetMs = 0;

export function syncServerTime(iso: string) {
  const server = Date.parse(iso);
  if (!Number.isNaN(server)) offsetMs = server - Date.now();
}

export function nowMs() {
  return Date.now() + offsetMs;
}
