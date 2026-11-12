import { nowMs } from "./clock";
import { APP_LOCALE, APP_TIME_ZONE, DAY_MS } from "./constants";

// Explicit locale + time zone so the server and the browser format identically.
const dateFormatter = new Intl.DateTimeFormat(APP_LOCALE, {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: APP_TIME_ZONE,
});
const shortDateFormatter = new Intl.DateTimeFormat(APP_LOCALE, {
  month: "short",
  day: "numeric",
  timeZone: APP_TIME_ZONE,
});
const dateTimeFormatter = new Intl.DateTimeFormat(APP_LOCALE, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: APP_TIME_ZONE,
});
const monthFormatter = new Intl.DateTimeFormat(APP_LOCALE, {
  month: "short",
  timeZone: "UTC",
});
const longMonthFormatter = new Intl.DateTimeFormat(APP_LOCALE, {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: APP_TIME_ZONE,
});

export const formatDate = (iso: string) => dateFormatter.format(new Date(iso));
export const formatShortDate = (iso: string) =>
  shortDateFormatter.format(new Date(iso));
export const formatDateTime = (iso: string) =>
  dateTimeFormatter.format(new Date(iso));

export function formatMonthKey(key: string, long = false) {
  const [year, month] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  return (long ? longMonthFormatter : monthFormatter).format(date);
}

/** YYYY-MM-DD for a timestamp, in the app time zone. Use in event handlers only. */
export function dayKey(ms: number) {
  return dayKeyFormatter.format(new Date(ms));
}

/** Today's YYYY-MM-DD in the app time zone, from the server-anchored clock. */
export function todayKey() {
  return dayKey(nowMs());
}

export function isoDayUtc(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatRelative(iso: string, now = nowMs()) {
  // Compare calendar days in Nepal Time, so "now"-stamped records never read as "Tomorrow".
  const NPT_OFFSET_MS = 5.75 * 3_600_000;
  const day = (ms: number) => Math.floor((ms + NPT_OFFSET_MS) / DAY_MS);
  const days = day(now) - day(new Date(iso).getTime());
  if (days < -1) return `in ${-days}d`;
  if (days === -1) return "Tomorrow";
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const timeFormatter = new Intl.DateTimeFormat(APP_LOCALE, { hour: "numeric", minute: "2-digit", timeZone: APP_TIME_ZONE });
export const formatTime = (iso: string) => timeFormatter.format(new Date(iso));

/** "just now", "4m ago", "3h ago", then a short date. For live, minute-level stamps. */
export function formatTimeAgo(iso: string, now = nowMs()) {
  const diff = Math.max(0, now - new Date(iso).getTime());
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return formatShortDate(iso);
}

export function signed(value: number) {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
  return "0";
}
