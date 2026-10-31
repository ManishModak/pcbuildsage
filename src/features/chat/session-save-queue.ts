import { fetchSession, HttpError, type SaveSessionOptions, type SaveSessionRequest } from "@/lib/api-client";
import { markInterruptedToolCalls } from "@/lib/sessions/interrupted-tools";
import type { ChatUIMessage } from "./message";

type SessionSnapshot = Omit<SaveSessionRequest, "revision">;
/**
 * `whileStreaming` records that the snapshot was taken mid-reply: the stream kept
 * going after it, so by the time a conflict on it resolves the local transcript
 * has moved on and adopting the server copy would throw that newer content away.
 */
type PendingSave = { signature: string; request: SaveSessionRequest; urgent: boolean; whileStreaming: boolean };

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
   *
   * Must return the messages exactly as stored, **without** the load-time
   * "Interrupted" repair: a mid-stream save is compared against it byte for byte,
   * and a repaired copy would never match the save that actually landed. The
   * queue applies the repair itself when it hands an adopted copy to the view.
   */
  loadServerCopy?: () => Promise<ServerSessionCopy | null>;
  onConflictAdopted?: (copy: ServerSessionCopy) => void;
  /** Called once retries are exhausted, so the UI can tell the user. */
  onPersistError?: (error: unknown) => void;
  /** Backoff between transient retries. Keep it short: a tab can close at any time. */
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  /**
   * True while this chat has a reply streaming in. A conflict resolved while a
   * stream is live must not swap the transcript under it (`onConflictAdopted`
   * replaces the messages the stream is appending to), so adoption is deferred
   * until the stream ends - see `drainDeferredConflict`. The view supplies this
   * late via `setHandlers`, reading its own streaming ref.
   */
  isStreaming?: () => boolean;
};

/** What `drainDeferredConflict` decided about a conflict held back while streaming. */
export type DeferredConflictOutcome =
  /** No conflict was held back, or there was nothing local left to decide with. */
  | "none"
  /** Nothing local changed while streaming, so the server copy was adopted. */
  | "adopted"
  /**
   * The transcript moved while streaming, so the server revision was observed
   * and the caller must re-save the local transcript on top of it.
   */
  | "needs-resave";

const DEFAULT_RETRY_DELAYS_MS = [250, 1000, 4000];

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
  /**
   * A conflict held back because a stream was live when it resolved. The
   * transcript it carries is the server's; `localSignature` is what we failed
   * to save, so the stream-end handler can tell "nothing changed, adopt" from
   * "re-save on top".
   */
  private deferredConflict: { copy: ServerSessionCopy; localSignature: string } | null = null;
  /**
   * The newest snapshot that exhausted its retries on a transient failure
   * (offline, 5xx). It stays unacknowledged, and it is kept here - not dropped -
   * so an `online` event or an explicit retry can send it again. Only the
   * newest such snapshot is kept: anything queued later supersedes it.
   */
  private unsavedAfterFailure: PendingSave | null = null;
  /** Backoff timers still waiting, so `dispose` can cancel them. */
  private readonly timers = new Set<{ handle: ReturnType<typeof setTimeout>; resolve: () => void }>();
  private disposed = false;
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

  /**
   * True while there is a transcript on this device that no store holds: a
   * snapshot waiting behind an in-flight request, a conflict held back while
   * streaming, or a snapshot whose retries ran out on a transient failure. The
   * chat header reads this as "Not saved yet". An in-flight request alone does
   * not count: it is on its way, and flagging every 200ms flight would flicker.
   */
  hasUnsaved(): boolean {
    return this.pending !== null || this.deferredConflict !== null || this.unsavedAfterFailure !== null;
  }

  /**
   * True while dropping this queue would lose or abandon a write: anything
   * `hasUnsaved` counts, plus a request in flight (its retries and conflict
   * handling still need the queue). The pool never evicts a chat while this holds.
   */
  hasPendingWork(): boolean {
    return this.hasUnsaved() || this.running !== null;
  }

  /**
   * Stop retrying: cancel any backoff timer and let an in-progress drain finish
   * without another attempt. Called when the chat leaves the pool or is deleted.
   */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) {
      clearTimeout(timer.handle);
      timer.resolve();
    }
    this.timers.clear();
  }

  /**
   * Re-queue the snapshot that a transient failure left unsaved, if it is still
   * newer than what is acknowledged. Returns false when there is nothing to
   * retry. The view calls this on the `online` event and when the user asks to
   * retry; the snapshot keeps its content but claims a fresh revision, like any
   * other retry.
   */
  retryUnsaved(): boolean {
    const unsaved = this.unsavedAfterFailure;
    if (!unsaved || unsaved.signature === this.acknowledgedSignature) {
      this.unsavedAfterFailure = null;
      return false;
    }
    // A newer snapshot queued since supersedes the failed one.
    if (this.pending && this.pending.signature !== unsaved.signature) {
      this.unsavedAfterFailure = null;
      return false;
    }
    this.unsavedAfterFailure = null;
    const { revision: _claimed, ...snapshot } = unsaved.request;
    void _claimed;
    void this.enqueue(unsaved.signature, snapshot, unsaved.urgent ? { urgent: true } : undefined);
    // A retried mid-stream snapshot is still one the stream moved past.
    if (this.pending?.signature === unsaved.signature && unsaved.whileStreaming) this.pending.whileStreaming = true;
    return true;
  }

  /**
   * Resolve a conflict that was held back while a stream was live. Call when
   * the stream ends with the transcript as it now stands:
   *
   * - same signature as the failed save: nothing local changed, so the server
   *   copy is adopted (through `onConflictAdopted`, exactly as if it had
   *   resolved after the stream).
   * - different signature: the stream added turns on top of the failed save, so
   *   the server revision is observed and the caller must re-save the local
   *   transcript on top of it.
   */
  drainDeferredConflict(localSignature: string): DeferredConflictOutcome {
    const deferred = this.deferredConflict;
    if (!deferred) return "none";
    this.deferredConflict = null;
    if (localSignature === deferred.localSignature) {
      this.adoptNow(deferred.copy);
      return "adopted";
    }
    this.observeRevision(deferred.copy.revision);
    return "needs-resave";
  }

  /**
   * A transcript just loaded from storage is already durable. Acknowledge it so
   * opening a chat does not write it straight back (which would bump its
   * revision and updated_at, and persist load-time repairs such as
   * "Interrupted" tool parts). Ignored while a save is queued or in flight.
   */
  observeLoaded(signature: string, revision: number): void {
    this.observeRevision(revision);
    if (!this.pending && !this.running) this.acknowledgedSignature = signature;
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
        urgent,
        whileStreaming: this.streamingNow()
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
          if (this.unsavedAfterFailure?.signature === current.signature) this.unsavedAfterFailure = null;
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
    const sleep = this.options.sleep;
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
        // A newer snapshot is queued: it already contains this one, so drop the
        // stale retry instead of burning the queue's time on old data.
        if (this.hasNewerPending(current)) return false;

        await this.sleep(sleep, delays[attemptIndex - 1] ?? delays[delays.length - 1] ?? 0);
        if (this.disposed) {
          this.keepUnsaved(current);
          return false;
        }
        if (this.hasNewerPending(current)) return false;

        // Find out what the server actually holds before re-sending anything. A
        // bumped revision is by construction newer than whatever a competing tab
        // wrote, so rebasing blind is exactly how a retry destroys the other tab's
        // work - the thing the conflict rule exists to prevent.
        const verdict = await this.reconcileBeforeRebase(current, request);
        if (verdict === "unresolved") {
          // The server could not be asked. Writing would be a guess, so probe
          // again after the next backoff; once the retries run out, keep the
          // snapshot for an explicit retry rather than dropping it silently.
          if (attemptIndex < maxAttempts - 1) continue;
          this.keepUnsaved(current);
          return false;
        }
        // "acknowledged": our earlier attempt did land after all. "adopted": the
        // snapshot was not written, so it stays unacknowledged.
        if (verdict !== "rebase") return verdict === "acknowledged";

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
          return await this.resolveConflict(current, request);
        }

        if (!isTransient(error)) {
          // An oversize page-close flush is an expected outcome, not a save
          // failure: storage is working and the throttle is still saving. The
          // snapshot stays unacknowledged, so the next ordinary save carries it.
          if (!isKeepaliveOversize(error)) this.options.onPersistError?.(error);
          return false;
        }

        // Offline is transient, but burning the whole backoff on it is pure
        // waste: nothing will succeed until the browser is back. Keep the
        // snapshot for the `online` retry instead of giving up silently.
        if (isOffline()) {
          this.keepUnsaved(current);
          return false;
        }
      }
    }

    this.keepUnsaved(current);
    this.options.onPersistError?.(lastError);
    return false;
  }

  /** Whether a different, newer snapshot is waiting behind `current`. */
  private hasNewerPending(current: PendingSave): boolean {
    return this.pending !== null && this.pending.signature !== current.signature;
  }

  /** Backoff wait, tracked so `dispose` can cancel it. An injected `sleep` is used as is. */
  private sleep(injected: ((ms: number) => Promise<void>) | undefined, ms: number): Promise<void> {
    if (injected) return injected(ms);
    if (this.disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = {
        resolve,
        handle: setTimeout(() => {
          this.timers.delete(timer);
          resolve();
        }, ms)
      };
      this.timers.add(timer);
    });
  }

  /**
   * Remember a snapshot a transient failure left unsaved, so it can be retried
   * (on `online`, or explicitly) instead of sitting unacknowledged with nobody
   * told. Only the newest such snapshot is kept: anything enqueued later
   * already contains it.
   */
  private keepUnsaved(current: PendingSave): void {
    const fresh = this.pending;
    if (fresh && fresh.signature !== current.signature) return;
    this.unsavedAfterFailure = current;
  }

  /** Whether a reply is streaming in this chat right now, if the view said so. */
  private streamingNow(): boolean {
    try {
      return this.options.isStreaming?.() === true;
    } catch {
      return false;
    }
  }

  /**
   * What to do with a snapshot that is about to be retried.
   *
   * - `acknowledged`: the server already holds exactly this transcript, so the
   *   earlier attempt landed and only its response was lost. Nothing to write.
   * - `adopted`: another tab has since saved this session, and its copy wins
   *   (or, when local work is newer, it was observed and a re-save queued).
   * - `unresolved`: the server could not be asked, so writing would be a guess.
   * - `rebase`: the server is still behind this attempt - or holds no copy at
   *   all, e.g. a brand-new chat whose first save hit a 5xx - so re-sending with
   *   a newer revision cannot destroy anyone's work.
   */
  private async reconcileBeforeRebase(
    current: PendingSave,
    attempt: SaveSessionRequest
  ): Promise<"acknowledged" | "adopted" | "unresolved" | "rebase"> {
    const copy = await this.readServerCopy();
    if (copy === undefined) return "unresolved";
    if (copy === null) return "rebase";
    if (sessionSignature(copy.messages) === current.signature) return "acknowledged";
    if (copy.revision < attempt.revision) return "rebase";
    this.adoptServerCopy(current, copy);
    return "adopted";
  }

  /**
   * A `stale_revision` means someone else saved this session after us. Adopt
   * their copy instead of resending our stale messages with a bumped revision,
   * which would silently discard their work.
   *
   * This never writes: the adopted copy is handed back to the view, and anything
   * the user does next is re-enqueued through the normal queue path. While a
   * reply is streaming the adoption is held back instead (see
   * `drainDeferredConflict`): swapping the transcript mid-stream would pull the
   * messages the stream is appending to out from under it.
   */
  private async resolveConflict(current: PendingSave, attempt: SaveSessionRequest): Promise<boolean> {
    const copy = await this.readServerCopy();
    if (!copy) {
      // The conflict is left for a later edit/load to observe - and the snapshot
      // is kept for an explicit retry, so this is not a silent drop.
      this.keepUnsaved(current);
      return false;
    }
    // The server already holds exactly this transcript: an earlier attempt landed.
    if (sessionSignature(copy.messages) === current.signature) {
      this.observeRevision(copy.revision);
      return true;
    }
    // A stale_revision means the server's revision is at least ours. An equal one
    // is the common two-tab case (both tabs saved the same next revision), so it
    // is a real conflict too - not adopting it would let our next save, one
    // revision higher, overwrite the other tab's turn.
    if (copy.revision < attempt.revision) return false;
    this.adoptServerCopy(current, copy);
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
   *
   * While a reply is streaming the handoff is held back instead: the view would
   * replace the very messages the stream is appending to, and the next save -
   * one revision higher - would then be built from a transcript that is neither
   * ours nor theirs. The copy waits in `deferredConflict` (the revision is
   * deliberately *not* observed yet) until `drainDeferredConflict` runs at
   * stream end.
   */
  private adoptServerCopy(current: PendingSave, copy: ServerSessionCopy): void {
    if (this.streamingNow()) {
      this.deferredConflict = { copy, localSignature: current.signature };
      return;
    }
    // Local content is newer than the conflicting save - the stream kept going
    // after it, or a later snapshot is already queued. Adopting would replace
    // that newer content (typically the reply that just finished), so keep it
    // and re-save it on top of the server revision instead.
    if (current.whileStreaming || this.hasNewerPending(current)) {
      this.resaveOnTop(current, copy);
      return;
    }
    this.adoptNow(copy);
  }

  /**
   * Observe the server revision and queue the newest local snapshot (the one
   * waiting, else the one that conflicted) at a revision above it. The re-save
   * no longer counts as mid-stream, so a second conflict on it resolves normally
   * instead of re-saving forever.
   */
  private resaveOnTop(current: PendingSave, copy: ServerSessionCopy): void {
    this.observeRevision(copy.revision);
    const base = this.pending ?? current;
    this.pending = {
      ...base,
      request: { ...base.request, revision: ++this.nextRevision },
      whileStreaming: false
    };
  }

  /**
   * Hand the server copy to the view, repaired for display, and acknowledge it:
   * it is what storage holds, so the view echoing it back must not re-save it.
   */
  private adoptNow(copy: ServerSessionCopy): void {
    this.observeRevision(copy.revision);
    const messages = markInterruptedToolCalls(copy.messages) as ChatUIMessage[];
    this.acknowledgedSignature = sessionSignature(messages);
    this.options.onConflictAdopted?.({ ...copy, messages });
  }
}

/**
 * The `loadServerCopy` every pooled chat uses: the stored session, unrepaired
 * (see `SessionSaveQueueOptions.loadServerCopy`), or null when there is none.
 */
export async function loadServerSessionCopy(id: string): Promise<ServerSessionCopy | null> {
  const session = await fetchSession(id, { markInterrupted: false });
  return session
    ? {
        revision: session.revision,
        messages: session.messages,
        // Carried with the transcript: a compacted context summarises specific
        // messages, so adopting the transcript alone would leave this tab saving
        // a summary of the wrong conversation.
        compactContext: session.compact_context ?? null
      }
    : null;
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

/**
 * Whether the browser reports itself as offline. A failed `fetch` while
 * offline rejects with a `TypeError`, which is transient - but the queue treats
 * an explicitly offline browser as "hold for the `online` event" rather than
 * burning its backoff. Absent (non-browser tests, SSR) means "not offline".
 */
function isOffline(): boolean {
  try {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  } catch {
    return false;
  }
}
