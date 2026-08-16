import { HttpError, type SaveSessionRequest } from "@/lib/api-client";

type SessionSnapshot = Omit<SaveSessionRequest, "revision">;
type PendingSave = { signature: string; request: SaveSessionRequest };

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

  constructor(
    private readonly persist: (request: SaveSessionRequest) => Promise<void>,
    initialSignature: string,
    initialRevision = 0,
    onPersisted: () => void = () => {}
  ) {
    this.acknowledgedSignature = initialSignature;
    this.nextRevision = initialRevision;
    this.onPersisted = onPersisted;
  }

  setOnPersisted(onPersisted: () => void): void {
    this.onPersisted = onPersisted;
  }

  observeRevision(revision: number): void {
    this.nextRevision = Math.max(this.nextRevision, revision);
  }

  enqueue(signature: string, snapshot: SessionSnapshot): Promise<void> {
    if (signature === this.acknowledgedSignature) return this.running ?? Promise.resolve();
    if (signature !== this.pending?.signature) {
      this.pending = {
        signature,
        request: { ...snapshot, revision: ++this.nextRevision }
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
        try {
          await this.persist(current.request);
          this.acknowledgedSignature = current.signature;
          this.onPersisted();
        } catch (error) {
          const staleRevision = getStaleRevision(error);
          if (staleRevision !== null) {
            this.nextRevision = Math.max(this.nextRevision, staleRevision);
            const retry = this.pending ?? current;
            this.pending = null;
            retry.request = { ...retry.request, revision: ++this.nextRevision };
            try {
              await this.persist(retry.request);
              this.acknowledgedSignature = retry.signature;
              this.onPersisted();
            } catch {
              // A second conflict is left unacknowledged. A later edit or load
              // observes the newest server revision before trying again.
            }
            continue;
          }
          // Prefer a newer queued snapshot over retrying stale data. Otherwise,
          // make one immediate retry for a transient local/network failure.
          if (!this.pending && (!(error instanceof HttpError) || error.status >= 500)) {
            try {
              await this.persist(current.request);
              this.acknowledgedSignature = current.signature;
              this.onPersisted();
            } catch {
              // Leave the exact signature unacknowledged so a later enqueue can
              // retry it; never advance durability state on a failed response.
            }
          }
        }
      }
    } finally {
      this.running = null;
      if (this.pending) this.running = this.drain();
    }
  }
}

export function sessionSignature(messages: SaveSessionRequest["messages"]): string {
  return JSON.stringify(messages);
}

function getStaleRevision(error: unknown): number | null {
  if (!(error instanceof HttpError) || error.status !== 409 || !isRecord(error.body)) return null;
  return error.body.error === "stale_revision" && Number.isInteger(error.body.revision)
    ? Number(error.body.revision)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
