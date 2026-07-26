/**
 * A generic reuse (object) pool. In A2A hot loops the envelope objects are
 * short-lived and structurally identical, so allocating a fresh one per publish
 * churns the GC. A {@link MessagePool} lets a producer *acquire* a recycled
 * object, mutate it, publish, and *release* it back — turning allocation into
 * bookkeeping. The pool is transport-agnostic; `T` can be an envelope, a chunk,
 * or any reusable value.
 */

/** Snapshot of pool usage — the gap between `created` and `acquired` is reuse. */
export interface PoolStats {
  /** Objects the factory has ever produced. */
  created: number;
  /** Total successful `acquire()` calls. */
  acquired: number;
  /** Total successful `release()` calls. */
  released: number;
  /** Acquisitions served from the idle set (not the factory). */
  reused: number;
  /** Objects currently checked out (acquired but not released). */
  inUse: number;
  /** Objects currently sitting in the idle set. */
  idle: number;
}

/**
 * A pool that recycles objects of type `T`. `factory` builds a fresh object;
 * `reset` returns a released object to a clean baseline before it re-enters the
 * idle set. `maxIdle` caps retained idle objects so a burst of releases can't
 * grow the pool without bound (excess releases are simply dropped for the GC).
 */
export class MessagePool<T> {
  private readonly idle: T[] = [];
  private readonly maxIdle: number;
  private _created = 0;
  private _acquired = 0;
  private _released = 0;
  private _reused = 0;
  private _inUse = 0;

  constructor(
    private readonly factory: () => T,
    private readonly reset: (obj: T) => void,
    opts: { maxIdle?: number } = {}
  ) {
    this.maxIdle = opts.maxIdle ?? 1024;
  }

  /** Reuse an idle object if one exists, otherwise build a fresh one. */
  acquire(): T {
    let obj: T;
    const recycled = this.idle.pop();
    if (recycled !== undefined) {
      obj = recycled;
      this._reused++;
    } else {
      obj = this.factory();
      this._created++;
    }
    this._acquired++;
    this._inUse++;
    return obj;
  }

  /** Reset `obj` and return it to the idle set (dropped if idle is full). */
  release(obj: T): void {
    this.reset(obj);
    this._released++;
    if (this._inUse > 0) this._inUse--;
    if (this.idle.length < this.maxIdle) {
      this.idle.push(obj);
    }
  }

  stats(): PoolStats {
    return {
      created: this._created,
      acquired: this._acquired,
      released: this._released,
      reused: this._reused,
      inUse: this._inUse,
      idle: this.idle.length,
    };
  }

  idleCount(): number {
    return this.idle.length;
  }
}
