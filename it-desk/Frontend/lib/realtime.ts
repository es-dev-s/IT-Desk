import { API_BASE_URL } from "./api";

/**
 * One Server-Sent Events connection to GET /api/v1/events.
 *
 * - Auth is the session cookie (withCredentials); the server filters every
 *   event by the viewer's role and team, so nothing to filter here.
 * - The browser's own EventSource retry resumes with Last-Event-ID. When it
 *   gives up (HTTP error, API down for long) we reconnect ourselves with
 *   jittered exponential backoff and pass ?lastEventId= so nothing is lost.
 * - A watchdog reconnects if no frame (not even the ~20s ping) arrives in 45s,
 *   which catches half-open sockets after sleep or a network switch.
 * - `online` / tab-visible reconnect immediately instead of waiting out backoff.
 */
export type LiveStatus = "idle" | "connecting" | "live" | "reconnecting" | "offline";

export type LiveHandlers = {
  onStatus: (status: LiveStatus) => void;
  /** A named SSE event with its parsed JSON payload. `id` is set for notifications. */
  onEvent: (type: string, data: unknown, id: number | null) => void;
};

const EVENTS = ["ready", "notification", "entity", "read", "ping", "session", "reconnect"] as const;
const WATCHDOG_MS = 45_000;
const BASE_DELAY = 1_000;
const MAX_DELAY = 30_000;

export class LiveConnection {
  private es: EventSource | null = null;
  private lastEventId = 0;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private status: LiveStatus = "idle";

  constructor(private readonly handlers: LiveHandlers) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    document.addEventListener("visibilitychange", this.onVisible);
    this.connect();
  }

  stop() {
    this.stopped = true;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    document.removeEventListener("visibilitychange", this.onVisible);
    this.teardown();
    this.clearRetry();
    this.setStatus("idle");
  }

  /** Drop the socket and reconnect soon (server asked, or the session changed). */
  reconnect(delayMs = 250) {
    if (this.stopped) return;
    this.teardown();
    this.schedule(delayMs);
  }

  get lastId() {
    return this.lastEventId;
  }

  private setStatus(s: LiveStatus) {
    if (s === this.status) return;
    this.status = s;
    this.handlers.onStatus(s);
  }

  private connect() {
    if (this.stopped) return;
    this.clearRetry();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.setStatus("offline");
      return;
    }
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const url = `${API_BASE_URL}/api/v1/events${this.lastEventId ? `?lastEventId=${this.lastEventId}` : ""}`;
    const es = new EventSource(url, { withCredentials: true });
    this.es = es;
    this.arm();

    es.onopen = () => this.arm();
    es.onerror = () => {
      if (this.es !== es) return;
      if (es.readyState === EventSource.CLOSED) {
        // The browser gave up (non-200, CORS, API down): our backoff takes over.
        this.teardown();
        this.schedule();
      } else {
        // The browser is retrying on its own (retry: 3000) with Last-Event-ID.
        this.setStatus("reconnecting");
      }
    };
    for (const type of EVENTS) {
      es.addEventListener(type, (ev) => {
        if (this.es !== es) return;
        this.arm();
        const msg = ev as MessageEvent<string>;
        let data: unknown = null;
        try {
          data = msg.data ? JSON.parse(msg.data) : null;
        } catch {
          return;
        }
        const id = msg.lastEventId ? Number(msg.lastEventId) : NaN;
        if (Number.isFinite(id) && id > this.lastEventId) this.lastEventId = id;
        if (type === "ready") {
          this.attempt = 0;
          const last = (data as { lastEventId?: number } | null)?.lastEventId;
          if (typeof last === "number" && last > this.lastEventId) this.lastEventId = last;
          this.setStatus("live");
        }
        this.handlers.onEvent(type, data, type === "notification" && Number.isFinite(id) ? id : null);
      });
    }
  }

  private arm() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.reconnect(0), WATCHDOG_MS);
  }

  private teardown() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    if (this.es) {
      this.es.onerror = null;
      this.es.onopen = null;
      this.es.close();
      this.es = null;
    }
  }

  private schedule(delayMs?: number) {
    if (this.stopped) return;
    this.clearRetry();
    const n = this.attempt++;
    const delay = delayMs ?? Math.min(MAX_DELAY, BASE_DELAY * 2 ** n) * (0.6 + Math.random() * 0.8);
    this.setStatus(navigator.onLine === false ? "offline" : "reconnecting");
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private readonly onOnline = () => {
    if (this.stopped || this.es) return;
    this.attempt = 0;
    this.connect();
  };

  private readonly onOffline = () => {
    if (this.stopped) return;
    this.teardown();
    this.clearRetry();
    this.setStatus("offline");
  };

  private readonly onVisible = () => {
    if (this.stopped || document.visibilityState !== "visible") return;
    // Back from a sleeping laptop / background tab: if we're not live, go now.
    if (!this.es || this.es.readyState === EventSource.CLOSED) {
      this.attempt = 0;
      this.connect();
    }
  };
}
