import {
  LibraryChangeReason,
  type LibraryChangeReason as LibraryChangeReasonValue,
} from '../../../shared/library/constants';
import type { LibraryChangedPayload } from '../../../shared/library/types';

export const LibraryRefreshTiming = {
  QuietWindowMs: 300,
  MaxWaitMs: 1_000,
} as const;

export interface LibraryRefreshBatch {
  itemIds: string[];
  reasons: LibraryChangeReasonValue[];
  eventCount: number;
  requiresAuthoritativeRefresh: boolean;
}

interface LibraryRefreshScheduler {
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

interface LibraryRefreshCoordinatorOptions {
  onFlush: (batch: LibraryRefreshBatch) => Promise<void>;
  onError?: (error: unknown) => void;
  quietWindowMs?: number;
  maxWaitMs?: number;
  scheduler?: LibraryRefreshScheduler;
}

const defaultScheduler: LibraryRefreshScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer),
};

export class LibraryRefreshCoordinator {
  private readonly onFlush: LibraryRefreshCoordinatorOptions['onFlush'];
  private readonly onError?: LibraryRefreshCoordinatorOptions['onError'];
  private readonly quietWindowMs: number;
  private readonly maxWaitMs: number;
  private readonly scheduler: LibraryRefreshScheduler;
  private readonly itemIds = new Set<string>();
  private readonly reasons = new Set<LibraryChangeReasonValue>();
  private eventCount = 0;
  private requiresAuthoritativeRefresh = false;
  private quietTimer?: ReturnType<typeof setTimeout>;
  private maxTimer?: ReturnType<typeof setTimeout>;
  private active = false;
  private inFlight = false;
  private disposed = false;

  constructor(options: LibraryRefreshCoordinatorOptions) {
    this.onFlush = options.onFlush;
    this.onError = options.onError;
    this.quietWindowMs = options.quietWindowMs ?? LibraryRefreshTiming.QuietWindowMs;
    this.maxWaitMs = options.maxWaitMs ?? LibraryRefreshTiming.MaxWaitMs;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  enqueue(payload: LibraryChangedPayload): void {
    if (this.disposed || payload.reason === LibraryChangeReason.Favorite) return;
    this.eventCount += 1;
    this.reasons.add(payload.reason);
    const itemIds = payload.itemIds?.filter(Boolean) ?? [];
    for (const itemId of itemIds) this.itemIds.add(itemId);
    if (payload.reason === LibraryChangeReason.Repair || itemIds.length === 0) {
      this.requiresAuthoritativeRefresh = true;
    }
    if (this.active) this.schedule();
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (!active) {
      this.clearTimers();
      return;
    }
    if (this.hasPendingBatch()) this.requestFlush();
  }

  flushNow(): void {
    if (this.disposed || !this.active || !this.hasPendingBatch()) return;
    this.requestFlush();
  }

  dispose(): void {
    this.disposed = true;
    this.active = false;
    this.clearTimers();
    this.resetPendingBatch();
  }

  private schedule(): void {
    if (this.quietTimer !== undefined) this.scheduler.clearTimeout(this.quietTimer);
    this.quietTimer = this.scheduler.setTimeout(() => {
      this.quietTimer = undefined;
      this.requestFlush();
    }, this.quietWindowMs);
    if (this.maxTimer === undefined) {
      this.maxTimer = this.scheduler.setTimeout(() => {
        this.maxTimer = undefined;
        this.requestFlush();
      }, this.maxWaitMs);
    }
  }

  private requestFlush(): void {
    if (this.disposed || !this.active || !this.hasPendingBatch()) return;
    if (this.inFlight) {
      this.clearTimers();
      return;
    }
    this.clearTimers();
    const batch = this.takePendingBatch();
    this.inFlight = true;
    void this.runFlush(batch);
  }

  private async runFlush(batch: LibraryRefreshBatch): Promise<void> {
    try {
      await this.onFlush(batch);
    } catch (error) {
      this.onError?.(error);
    } finally {
      this.inFlight = false;
      if (!this.disposed && this.active && this.hasPendingBatch()) {
        this.requestFlush();
      }
    }
  }

  private takePendingBatch(): LibraryRefreshBatch {
    const batch: LibraryRefreshBatch = {
      itemIds: [...this.itemIds],
      reasons: [...this.reasons],
      eventCount: this.eventCount,
      requiresAuthoritativeRefresh: this.requiresAuthoritativeRefresh,
    };
    this.resetPendingBatch();
    return batch;
  }

  private hasPendingBatch(): boolean {
    return this.eventCount > 0;
  }

  private resetPendingBatch(): void {
    this.itemIds.clear();
    this.reasons.clear();
    this.eventCount = 0;
    this.requiresAuthoritativeRefresh = false;
  }

  private clearTimers(): void {
    if (this.quietTimer !== undefined) this.scheduler.clearTimeout(this.quietTimer);
    if (this.maxTimer !== undefined) this.scheduler.clearTimeout(this.maxTimer);
    this.quietTimer = undefined;
    this.maxTimer = undefined;
  }
}
