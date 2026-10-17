/**
 * @fileoverview Lock‑Free Atomic Queue implementation using SharedArrayBuffer & Atomics.
 *
 * The queue is a fixed‑size ring buffer that supports multiple concurrent producers
 * and consumers without any mutexes. Indices are stored in a 32‑bit Int32Array that
 * lives inside a SharedArrayBuffer, allowing worker threads to coordinate safely.
 *
 * Because JavaScript objects cannot be stored directly inside a SharedArrayBuffer,
 * the payloads are kept in a regular JavaScript array (`_store`). The atomic indices
 * guarantee that each slot is accessed by at most one producer and one consumer at a
 * time, eliminating race conditions while keeping GC pressure minimal.
 *
 * @author Suman Mehta
 * @license MIT
 */

/**
 * @template T
 */
export class LockFreeQueue {
  /**
   * Creates a new lock‑free queue.
   * @param {number} capacity Must be a power of two for optimal modulo operation.
   */
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('capacity must be a positive integer');
    }
    // Ensure power‑of‑two for bit‑mask wrap‑around.
    if ((capacity & (capacity - 1)) !== 0) {
      throw new RangeError('capacity must be a power of two');
    }
    this._capacity = capacity;
    this._mask = capacity - 1;

    // Shared buffer holds two 32‑bit counters: head (consumer) and tail (producer).
    this._sab = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
    this._counters = new Int32Array(this._sab);
    // Index 0 => head, Index 1 => tail.
    this._headIdx = 0;
    this._tailIdx = 1;

    // Payload storage – plain array, not shared. Workers must import the same module
    // instance to see the same reference.
    this._store = new Array(capacity);
  }

  /**
   * Enqueues an item.
   * @param {T} item The value to enqueue.
   * @returns {boolean} `true` if the item was placed, `false` if the queue is full.
   */
  enqueue(item) {
    // Fast‑path: reserve a slot by atomically incrementing tail.
    const tail = Atomics.load(this._counters, this._tailIdx);
    const head = Atomics.load(this._counters, this._headIdx);
    if ((tail - head) === this._capacity) {
      // Full.
      return false;
    }
    const slot = tail & this._mask;
    // Store the payload before publishing the slot.
    this._store[slot] = item;
    // Publish the new tail – release semantics ensure the store is visible.
    Atomics.store(this._counters, this._tailIdx, tail + 1);
    // Wake a waiting consumer (optional, Node's Atomics.wait is only for Int32Array).
    Atomics.notify(this._counters, this._headIdx, 1);
    return true;
  }

  /**
   * Dequeues an item.
   * @returns {T|undefined} The next item or `undefined` if the queue is empty.
   */
  dequeue() {
    const head = Atomics.load(this._counters, this._headIdx);
    const tail = Atomics.load(this._counters, this._tailIdx);
    if (head === tail) {
      // Empty.
      return undefined;
    }
    const slot = head & this._mask;
    const item = this._store[slot];
    // Clear reference to aid GC.
    this._store[slot] = undefined;
    // Advance head.
    Atomics.store(this._counters, this._headIdx, head + 1);
    // Wake a waiting producer (optional).
    Atomics.notify(this._counters, this._tailIdx, 1);
    return item;
  }

  /**
   * Returns the current number of elements in the queue.
   * @returns {number}
   */
  size() {
    const head = Atomics.load(this._counters, this._headIdx);
    const tail = Atomics.load(this._counters, this._tailIdx);
    return tail - head;
  }

  /**
   * Returns the maximum capacity of the queue.
   * @returns {number}
   */
  capacity() {
    return this._capacity;
  }
}
