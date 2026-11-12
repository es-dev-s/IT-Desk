import { z } from "zod";
import { newIdempotencyKey, request } from "./api";

/* ----------------------------------------------------------------------------
 * IT staff directory: the people in IT a request can be routed to ("Assign
 * to"). Everyone who can see requests reads the active list; admins manage it
 * and can link an entry to that person's IT login, so they see what's routed
 * to them and reply in chat as themselves.
 * ------------------------------------------------------------------------- */

const iso = z.iso.datetime({ offset: true });

export const itStaffSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  title: z.string(),
  active: z.boolean(),
  sortOrder: z.number().int(),
  open: z.number().int().catch(0),
  createdAt: iso,
  updatedAt: iso,
  version: z.number().int().min(0),
  hasLogin: z.boolean().catch(false),
  /** Which account is linked: admins only. */
  login: z
    .object({ userId: z.string(), email: z.string(), name: z.string(), status: z.string() })
    .nullish()
    .transform((v) => v ?? null),
});
export type ITStaff = z.infer<typeof itStaffSchema>;

export const STAFF_LIMITS = { minName: 2, maxName: 80, maxTitle: 80 } as const;

/** Stable, low-chroma avatar hue per person (same name → same colour everywhere). */
export function staffHue(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const withKey = () => ({ idempotencyKey: newIdempotencyKey() });

export const itStaffApi = {
  list: (opts: { all?: boolean } = {}, signal?: AbortSignal) =>
    request(`/it-staff${opts.all ? "?all=true" : ""}`, { schema: z.array(itStaffSchema), signal }),
  create: (body: { name: string; title?: string; active?: boolean; sortOrder?: number }) =>
    request("/admin/it-staff", { method: "POST", body, schema: itStaffSchema, ...withKey() }),
  /** `userId: ""` unlinks the login. */
  update: (id: string, body: { name?: string; title?: string; active?: boolean; sortOrder?: number; userId?: string; expectedVersion?: number }) =>
    request(`/admin/it-staff/${encodeURIComponent(id)}`, { method: "PATCH", body, schema: itStaffSchema, ...withKey() }),
};
