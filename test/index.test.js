import test from 'node:test';
import assert from 'node:assert/strict';
import { LockFreeQueue } from '../src/index.js';

/**
 * Basic single‑threaded sanity checks.
 */
await test('enqueue & dequeue basic', t => {
  const q = new LockFreeQueue(8);
  assert.equal(q.size(), 0);
  assert.equal(q.dequeue(), undefined);
  assert.ok(q.enqueue('a'));
  assert.ok(q.enqueue('b'));
  assert.equal(q.size(), 2);
  assert.equal(q.dequeue(), 'a');
  assert.equal(q.dequeue(), 'b');
  assert.equal(q.dequeue(), undefined);
});

/**
 * Fill to capacity and ensure overflow is rejected.
 */
await test('full queue behavior', t => {
  const q = new LockFreeQueue(4);
  assert.ok(q.enqueue(1));
  assert.ok(q.enqueue(2));
  assert.ok(q.enqueue(3));
  assert.ok(q.enqueue(4));
  // Queue is now full.
  assert.equal(q.enqueue(5), false);
  assert.equal(q.size(), 4);
});

/**
 * Multi‑producer / multi‑consumer stress test using Worker Threads.
 */
await test('concurrent producers & consumers', async t => {
  const { Worker, isMainThread, parentPort } = await import('node:worker_threads');
  if (!isMainThread) {
    // Worker code – receives a shared buffer and performs ops.
    const { sab, capacity, ops, role } = parentPort.receiveMessageOnPort().message;
    const queue = new (await import('../src/index.js')).LockFreeQueue(capacity);
    // Re‑use the same SharedArrayBuffer.
    queue._sab = sab;
    queue._counters = new Int32Array(sab);
    if (role === 'producer') {
      for (let i = 0; i < ops; i++) {
        while (!queue.enqueue(i)) {
          // busy‑wait; in real world you could Atomics.wait.
        }
      }
    } else {
      let received = 0;
      while (received < ops) {
        const val = queue.dequeue();
        if (val !== undefined) received++;
      }
    }
    parentPort.postMessage('done');
    return;
  }

  const capacity = 1024;
  const opsPerWorker = 100_000;
  const sab = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
  const queue = new LockFreeQueue(capacity);
  // Replace internal buffers with the shared ones.
  queue._sab = sab;
  queue._counters = new Int32Array(sab);

  const producers = [];
  const consumers = [];
  for (let i = 0; i < 2; i++) {
    producers.push(new Worker(import.meta.url, { execArgv: [] }));
    consumers.push(new Worker(import.meta.url, { execArgv: [] }));
  }

  // Helper to send init message.
  const initWorker = (worker, role) => new Promise(res => {
    worker.once('online', () => {
      worker.postMessage({ sab, capacity, ops: opsPerWorker, role });
    });
    worker.once('message', msg => {
      if (msg === 'done') res();
    });
  });

  await Promise.all([
    ...producers.map(w => initWorker(w, 'producer')),
    ...consumers.map(w => initWorker(w, 'consumer')),
  ]);

  // After all workers finish, the queue should be empty.
  assert.equal(queue.size(), 0);
});
