/**
 * Tiny in-tab pub/sub for live "entity" events, so views that own their own
 * data (e.g. the admin Users table) can resync without RealtimeSync knowing
 * about them. RealtimeSync is the only publisher.
 */
export type LiveEntity = "transfer" | "it_request" | "member" | "user" | "team" | "floor";

type Listener = (change: string, id: string) => void;
const listeners = new Map<LiveEntity, Set<Listener>>();

export function onLive(entity: LiveEntity, cb: Listener): () => void {
  let set = listeners.get(entity);
  if (!set) listeners.set(entity, (set = new Set()));
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

export function emitLive(entity: LiveEntity, change: string, id: string) {
  for (const cb of listeners.get(entity) ?? []) {
    try {
      cb(change, id);
    } catch {
      // A broken subscriber must never break the live connection.
    }
  }
}
