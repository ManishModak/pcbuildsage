import { HttpError, type SaveSessionOptions, type SaveSessionRequest } from "@/lib/api-client";
import type { ChatUIMessage } from "./message";

type SessionSnapshot = Omit<SaveSessionRequest, "revision">;
type PendingSave = { signature: string; request: SaveSessionRequest; urgent: boolean };

/** `urgent` marks a best-effort page-close flush; see `SaveSessionOptions`. */
export type PersistOptions = SaveSessionOptions;

export type Persist = (request: SaveSessionRequest, options?: PersistOptions) => Promise<void>;

/**
 * The authoritative copy of a session, loaded by the host on request. Used to
 * resolve a revision conflict without clobbering whoever wrote last.
 */
export type ServerSessionCopy = {
  revision: number;
  messages: ChatUIMessage[];
  /**
   * The session's compacted context, if it has one. It describes a summary of
   * *those* messages, so adopting the transcript without it would leave this tab
   * holding a compacted context for a different conversation - and the next save,
   * which is revision+1 and therefore accepted, would make that mismatch durable.
   */
  compactContext?: unknown | null;
};

export type SessionSaveQueueOptions = {
  /**
   * Fetch the authoritative copy after a `stale_revision` conflict. The queue
   * compares revisions and only calls `onConflictAdopted` when the other copy is
   * actually newer, so a conflict never silently overwrites the other tab's work.
   */
  loadServerCopy?: () => Promise<ServerSessionCopy | null>;
  onConflictAdopted?: (copy: ServerSessionCopy) => void;
  /** Called once retries are exhausted, so the UI can tell the user. */
  onPersistError?: (error: unknown) => void;
  /** Backoff between transient retries. Keep it short: a tab can close at any time. */
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_RETRY_DELAYS_MS = [250, 1000, 4000];

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Serializes browser-owned session writes and keeps only the newest snapshot
 * waiting behind the in-flight request. A failed signature remains unacknowledged
 * and can be retried by enqueueing it again.
 */
export class SessionSaveQueue {
  private pending: PendingSave | null = null;
  private running: Promise<void> | null = null;
  private nextRevision: number;
  private acknowledgedSignature: string;
  private onPersisted: () => void;
  private options: SessionSaveQueueOptions;

  constructor(
    private readonly persist: Persist,
    initialSignature: string,
    initialRevision = 0,
    onPersisted: () => void = () => {},
    options: SessionSaveQueueOptions = {}
  ) {
    this.acknowledgedSignature = initialSignature;
    this.nextRevision = initialRevision;
    this.onPersisted = onPersisted;
    this.options = options;
  }

  setOnPersisted(onPersisted: () => void): void {
    this.onPersisted = onPersisted;
  }

  /**
   * Whether this exact transcript is the one currently held durably. The page-close
   * flush uses it to tell "nothing new to write" apart from "the last save failed and
   * this is my last chance", which it cannot infer on its own.
   */
  isAcknowledged(signature: string): boolean {
    return signature === this.acknowledgedSignature;
  }

  /**
   * Late-bind the collaborators a mounted view owns (UI callbacks). The workspace
   * supplies `loadServerCopy` at construction; the chat view supplies the handlers
   * that need React state.
   */
  setHandlers(handlers: Partial<SessionSaveQueueOptions>): void {
    this.options = { ...this.options, ...handlers };
  }

  observeRevision(revision: number): void {
    this.nextRevision = Math.max(this.nextRevision, revision);
  }

  enqueue(signature: string, snapshot: SessionSnapshot, options?: PersistOptions): Promise<void> {
    const urgent = options?.urgent === true;
    if (!urgent && signature === this.acknowledgedSignature) return this.running ?? Promise.resolve();
    // An urgent flush always becomes the pending snapshot: it is the last chance to
    // get a partial reply out before the page goes away, so it must not be skipped
    // just because an identical signature was saved a moment ago.
    if (urgent || signature !== this.pending?.signature) {
      this.pending = {
        signature,
        request: { ...snapshot, revision: ++this.nextRevision },
        urgent
      };
    }
    if (!this.running) this.running = this.drain();
    return this.running;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        const current = this.pending;
        this.pending = null;
        const saved = await this.attempt(current);
        if (saved) {
          this.acknowledgedSignature = current.signature;
          this.onPersisted();
        }
      }
    } finally {
      this.running = null;
      if (this.pending) this.running = this.drain();
    }
  }

  /**
   * One snapshot, with bounded retries for transient failures.
   *
   * Returns true only when the snapshot is durably stored. A false return leaves
   * `acknowledgedSignature` untouched, so the same content enqueued later is
   * written again rather than being mistaken for saved.
   */
  private async attempt(current: PendingSave): Promise<boolean> {
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const sleep = this.options.sleep ?? defaultSleep;
    // An urgent flush is the last attempt before the page unloads: waiting out a
    // backoff would mean the write never leaves, so try it once and give up.
    const maxAttempts = current.urgent ? 1 : delays.length + 1;
    // Each attempt claims a fresh revision. A retry that reused the previous
    // revision would be rejected as stale by the very rule that protects against
    // clobbering another writer, if the earlier attempt actually landed and only
    // its response was lost. Bumping keeps retries monotonic, so they always land.
    let request = current.request;

    let lastError: unknown;
    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
      if (attemptIndex > 0) {
        const fresh = this.pending;
        // A newer snapshot is queued: it already contains this one, so drop the
        // stale retry instead of burning the queue's time on old data.
        if (fresh && fresh.signature !== current.signature) return false;

        // Find out what the server actually holds before re-sending anything. A
        // bumped revision is by construction newer than whatever a competing tab
        // wrote, so rebasing blind is exactly how a retry destroys the other tab's
        // work - the thing the conflict rule exists to prevent.
        const verdict = await this.reconcileBeforeRebase(current, request);
        if (verdict !== "rebase") {
          // "acknowledged": our earlier attempt did land after all. The rest mean
          // the snapshot was not written, so it stays unacknowledged.
          return verdict === "acknowledged";
        }

        await sleep(delays[attemptIndex - 1] ?? delays[delays.length - 1] ?? 0);
        request = { ...request, revision: ++this.nextRevision };
      }

      try {
        await this.persist(request, { urgent: current.urgent });
        return true;
      } catch (error) {
        lastError = error;

        if (getSessionDeleted(error)) {
          // The chat was deleted. Resending cannot help, and re-creating it would
          // undo the user's delete.
          this.options.onPersistError?.(error);
          return false;
        }

        if (isStaleRevision(error)) {
          // Either the newer copy was adopted, or the host could not load one and
          // the conflict is left for a later edit/load to observe.
          return await this.resolveConflict(request);
        }

        if (!isTransient(error)) {
          // An oversize page-close flush is an expected outcome, not a save
          // failure: storage is working and the throttle is still saving. The
          // snapshot stays unacknowledged, so the next ordinary save carries it.
          if (!isKeepaliveOversize(error)) this.options.onPersistError?.(error);
          return false;
        }
      }
    }

    this.options.onPersistError?.(lastError);
    return false;
  }

  /**
   * What to do with a snapshot that is about to be retried.
   *
   * - `acknowledged`: the server already holds exactly this transcript, so the
   *   earlier attempt landed and only its response was lost. Nothing to write.
   * - `adopted`: another tab has since saved this session, and its copy wins.
   * - `unresolved`: the server's state is unknown, so writing would be a guess.
   * - `rebase`: the server is still behind this attempt, so re-sending with a
   *   newer revision cannot destroy anyone's work.
   */
  private async reconcileBeforeRebase(
    current: PendingSave,
    attempt: SaveSessionRequest
  ): Promise<"acknowledged" | "adopted" | "unresolved" | "rebase"> {
    const copy = await this.readServerCopy();
    if (copy === undefined) return "unresolved";
    if (copy === null) return this.options.loadServerCopy ? "unresolved" : "rebase";
    if (sessionSignature(copy.messages) === current.signature) return "acknowledged";
    if (copy.revision < attempt.revision) return "rebase";
    this.adoptServerCopy(copy);
    return "adopted";
  }

  /**
   * A `stale_revision` means someone else saved this session after us. Adopt
   * their copy instead of resending our stale messages with a bumped revision,
   * which would silently discard their work.
   *
   * This never writes: the adopted copy is handed back to the view, and anything
   * the user does next is re-enqueued through the normal queue path.
   */
  private async resolveConflict(attempt: SaveSessionRequest): Promise<boolean> {
    const copy = await this.readServerCopy();
    if (!copy || copy.revision <= attempt.revision) return false;
    this.adoptServerCopy(copy);
    // Our snapshot was not written, so it must not be acknowledged: the same
    // content enqueued later is still ours to save.
    return false;
  }

  /**
   * The authoritative copy, or `null` when there is none. `undefined` means the
   * host could not be asked, which is different from "the server has no copy".
   */
  private async readServerCopy(): Promise<ServerSessionCopy | null | undefined> {
    const load = this.options.loadServerCopy;
    if (!load) return null;
    try {
      return await load();
    } catch {
      return undefined;
    }
  }

  /**
   * Hand the other tab's copy to the view and take its revision as the new high
   * water mark, so a later save lands above it instead of colliding with it.
   */
  private adoptServerCopy(copy: ServerSessionCopy): void {
    this.nextRevision = Math.max(this.nextRevision, copy.revision);
    this.options.onConflictAdopted?.(copy);
  }
}

export function sessionSignature(messages: SaveSessionRequest["messages"]): string {
  return JSON.stringify(messages);
}

// ---------------------------------------------------------------------------
// Mid-stream persistence
// ---------------------------------------------------------------------------

/** Minimum gap between two saves while a reply is still streaming. */
export const STREAM_PERSIST_INTERVAL_MS = 5000;

export type StreamPersistDecision = "save" | "throttle" | "skip";

/**
 * Whether a message update should be written *while* a reply is streaming.
 *
 * Streaming is the case that used to lose everything: the old persist effect only
 * fired on `status === "ready" | "error"`, so closing the tab mid-reply threw
 * the partial answer away. Writing on every token would be absurd, so updates
 * are throttled to one per {@link STREAM_PERSIST_INTERVAL_MS}; the page-close
 * flush (below) covers the tail.
 */
export function decideStreamPersist(args: {
  streaming: boolean;
  signature: string;
  lastSavedSignature: string | null;
  lastSavedAt: number | null;
  now: number;
  intervalMs?: number;
}): StreamPersistDecision {
  if (!args.streaming) return "skip";
  if (args.signature === args.lastSavedSignature) return "skip";
  if (args.lastSavedAt === null) return "save";
  return args.now - args.lastSavedAt >= (args.intervalMs ?? STREAM_PERSIST_INTERVAL_MS) ? "save" : "throttle";
}

// ---------------------------------------------------------------------------
// Page-close flush
// ---------------------------------------------------------------------------

/** The slice of `Document`/`Window` the page-close flush needs. */
export type PageLifecycleEvents = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  readonly visibilityState?: string;
};

/**
 * Wire the best-effort flush into the two events that actually fire when a page
 * is being closed or backgrounded.
 *
 * `visibilitychange` -> hidden is MDN's recommendation. MDN, on `pagehide`: "The
 * best event to use to signal the end of a user's session is the
 * `visibilitychange` event. In browsers that don't support `visibilitychange` the
 * `pagehide` event is the next-best alternative." So `visibilitychange` is primary
 * and `pagehide` is the fallback, exactly as MDN orders them. The same page is
 * candid about the fallback's limits: "Like the `unload` and `beforeunload`
 * events, this event is not reliably fired by browsers, especially on mobile. For
 * example, the `pagehide` event is not fired at all" in the app-switcher-then-kill-
 * the-browser scenario.
 *
 * `beforeunload` and `unload` are deliberately not used. MDN, on `sendBeacon`:
 * "However, this is extremely unreliable. In many situations, especially on mobile,
 * the browser will not fire the `unload`, `beforeunload`, or `pagehide` events" -
 * and in the same app-switcher scenario, "these events will not fire". A
 * `beforeunload` handler also costs the back/forward cache - MDN, again on
 * `sendBeacon`: "Firefox will also exclude pages from the bfcache if they contain
 * `beforeunload` handlers."
 *
 * Guarantee, deliberately modest: a flush started from one of these events uses
 * `keepalive: true` so the unload does not abort the request, but nothing here can
 * promise the write lands if the process is killed outright, and MDN's `pagehide`
 * caveat above means the event may not even fire. The throttled mid-stream saves
 * are what make durability real; this is the last few seconds.
 */
export function registerPageCloseFlush(events: PageLifecycleEvents, flush: () => void): () => void {
  const onVisibilityChange = () => {
    if (events.visibilityState === "hidden") flush();
  };
  events.addEventListener("visibilitychange", onVisibilityChange);
  events.addEventListener("pagehide", flush);
  return () => {
    events.removeEventListener("visibilitychange", onVisibilityChange);
    events.removeEventListener("pagehide", flush);
  };
}

/**
 * Whether hiding or closing the page should trigger a write.
 *
 * `visibilitychange` (hidden) fires on an ordinary tab switch, not just a close,
 * and an urgent write deliberately bypasses the queue's own de-duplication. Without
 * this gate, switching tabs N times re-uploads an unchanged transcript N times -
 * on a long chat that is hundreds of kilobytes of pointless traffic, and on a chat
 * over the 64 KiB keepalive limit it produces a failed request every time.
 *
 * So flush when there is genuinely something the last save does not have: a live
 * stream, or a transcript the queue has not yet stored. The second case also
 * covers a failed save, because the queue only acknowledges what it actually wrote.
 */
export function shouldFlushOnPageHide(args: {
  messageCount: number;
  streaming: boolean;
  signature: string;
  isAcknowledged: (signature: string) => boolean;
}): boolean {
  if (args.messageCount === 0) return false;
  if (args.streaming) return true;
  return !args.isAcknowledged(args.signature);
}

// ---------------------------------------------------------------------------
// Error inspection
// ---------------------------------------------------------------------------

/**
 * The server's 409 `stale_revision`, or the browser store's twin of it. The
 * revision the server reports is deliberately not used to rebase: the queue asks
 * for the authoritative copy and compares that instead, so a stale write can
 * never be "fixed" by simply claiming a higher number.
 */
function isStaleRevision(error: unknown): boolean {
  if (isRecordConflict(error, "stale_revision")) return true;
  return (
    error instanceof HttpError &&
    error.status === 409 &&
    isRecord(error.body) &&
    error.body.error === "stale_revision"
  );
}

function getSessionDeleted(error: unknown): boolean {
  if (isRecordConflict(error, "session_deleted")) return true;
  return (
    error instanceof HttpError &&
    error.status === 409 &&
    isRecord(error.body) &&
    error.body.error === "session_deleted"
  );
}

/**
 * A page-close flush that could not fit through `keepalive`. Storage is fine and
 * the ordinary throttled saves are still landing, so this is neither a retryable
 * failure nor anything the user needs to hear about.
 */
function isKeepaliveOversize(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { isKeepaliveTooLarge?: unknown }).isKeepaliveTooLarge === true
  );
}

/**
 * Network hiccups and 5xx are worth another try. A rejected revision, a deleted
 * session, any other 4xx, a browser storage layer that is full or blocked, and an
 * oversize page-close flush will all fail identically every time, so retrying
 * them only delays the notice the user needs to see - or, for the flush, means
 * the page is gone before anything leaves.
 */
function isTransient(error: unknown): boolean {
  if (isKeepaliveOversize(error)) return false;
  if (error instanceof HttpError) return error.status >= 500 || error.status === 429;
  if (isStoreError(error)) return false;
  return true;
}

/** Detects `SessionPersistenceError` from `client-store` without importing it. */
function isStoreError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { isSessionPersistenceError?: unknown }).isSessionPersistenceError === true;
}

function isRecordConflict(
  error: unknown,
  reason: "stale_revision" | "session_deleted"
): error is { reason: "stale_revision" | "session_deleted"; revision: number | null } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { isSessionConflict?: unknown }).isSessionConflict === true &&
    (error as { reason?: unknown }).reason === reason
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
