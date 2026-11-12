export const APP_NAME = "IT-Desk";
export const APP_LOCALE = "en-US";
export const APP_TIME_ZONE = "Asia/Kathmandu";

export const DAY_MS = 86_400_000;

/** Seat codes: prefix + row letter + number, e.g. L4-A01 (unique on a floor). Same rule as the API. */
export const SEAT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,15}$/;

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Natural order for seat codes (L4-A2 before L4-A10); people without a seat last. */
export function compareSeats(a: string | null | undefined, b: string | null | undefined) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return collator.compare(a, b);
}

export const DEVICE_KINDS = [
  "laptop",
  "monitor",
  "dock",
  "phone",
  "keyboard",
  "mouse",
  "headset",
] as const;

export const IT_STATUSES = ["requested", "scheduled", "moved", "completed"] as const;

export const MEMBER_PAGE_SIZE = 24;
export const ACTIVITY_PAGE_SIZE = 12;
