import { z } from "zod";

/* ----------------------------------------------------------------------------
 * Session & role model, shared by server and client code. The API is the
 * authority: these permissions only decide what the UI shows. Every request is
 * re-checked server-side (deny by default + team scoping in SQL).
 * ------------------------------------------------------------------------- */

export const ROLES = ["admin", "team_lead", "it"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = { admin: "Admin", team_lead: "Team Lead", it: "IT" };

export const PERMISSIONS = [
  "self",
  "workspace.view",
  "teams.view",
  "members.view",
  "floor.view",
  "floors.manage",
  "seats.assign",
  "transfers.view",
  "transfers.create",
  "transfers.undo",
  "transfers.advance",
  "exits.view",
  "exits.create",
  "exits.undo",
  "analytics.view",
  "audit.view",
  "users.manage",
  "members.manage",
  "requests.view",
  "requests.create",
  "requests.cancel",
  "requests.comment",
  "requests.fulfil",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Session cookie names set by the API (`__Host-` prefix when served over HTTPS). */
export const SESSION_COOKIES = ["__Host-itdesk_session", "itdesk_session"] as const;

export const roleSchema = z.enum(ROLES);

export const userSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.email(),
  title: z.string(),
  role: roleSchema,
  teamId: z.string().min(1).optional(),
});
export type User = z.infer<typeof userSchema>;

export const sessionSchema = z.object({
  user: userSchema,
  roleLabel: z.string(),
  // Unknown permissions (a newer API) are kept as strings and simply never match.
  permissions: z.array(z.string()),
  csrfToken: z.string().min(16),
  mustChangePassword: z.boolean(),
  expiresAt: z.iso.datetime({ offset: true }),
  idleTimeoutSeconds: z.number().int().nonnegative(),
});
export type Session = z.infer<typeof sessionSchema>;

export const can = (session: Pick<Session, "permissions"> | null | undefined, permission: Permission) =>
  Boolean(session?.permissions.includes(permission));

/** Where each role lands after signing in (or when it opens "/"). */
export function homeFor(role: Role) {
  return role === "it" ? "/queue" : "/";
}

/**
 * Only same-app, absolute paths are accepted as a post-login destination, so a
 * crafted `?next=` can never bounce the user to another site.
 */
export function safeNext(value: string | null | undefined, fallback = "/") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (value.startsWith("/login") || value.startsWith("/change-password")) return fallback;
  try {
    const url = new URL(value, "http://x");
    if (url.origin !== "http://x") return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

/* ----------------------------------------------------------------------------
 * Password policy, mirrored from the API (auth.ValidateNewPassword) so users
 * get instant feedback. The server remains the source of truth.
 * ------------------------------------------------------------------------- */

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 128;
const COMMON = ["password", "123456", "qwerty", "letmein", "welcome", "admin", "itdesk", "iloveyou", "abc123", "changeme"];

export function passwordProblem(password: string, ctx: { email?: string; name?: string } = {}): string | null {
  const chars = [...password];
  const n = chars.length;
  if (n < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters`;
  if (n > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters`;
  if (!password.trim()) return "Password can’t be blank";
  const lower = password.toLowerCase();
  if (ctx.email) {
    const local = ctx.email.toLowerCase().split("@")[0];
    if (lower === ctx.email.toLowerCase() || (local.length >= 4 && lower.includes(local))) return "Password can’t contain your email";
  }
  for (const part of (ctx.name ?? "").toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && lower.includes(part)) return "Password can’t contain your name";
  }
  if (COMMON.some((bad) => lower.includes(bad) && n < bad.length + 8)) return "That password is too common";
  if (new Set(chars).size < 6) return "Use more varied characters";
  const classes = [/\p{Ll}/u, /\p{Lu}/u, /\p{Nd}/u, /[^\p{Ll}\p{Lu}\p{Nd}]/u].filter((re) => re.test(password)).length;
  if (classes < 2 && n < 16) return "Mix letters with numbers or symbols, or use a longer passphrase";
  return null;
}

/** 0–4 meter for the change-password screen. */
export function passwordStrength(password: string) {
  if (!password) return 0;
  let score = 0;
  if (password.length >= MIN_PASSWORD) score++;
  if (password.length >= 16) score++;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes >= 3) score++;
  if (classes === 4 || password.length >= 20) score++;
  return Math.min(4, score);
}
