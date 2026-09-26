// Shared test helpers for the online code.
import type { Clock } from '../src/net/session.ts';

interface Timer {
  at: number;
  fn: () => void;
  every?: number;
}

/** Lets queued loopback messages (microtasks) arrive. */
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A clock whose timers only run when the test advances time. */
export class FakeClock implements Clock {
  t: number;
  timers: Map<number, Timer>;
  nextId: number;

  constructor() {
    this.t = 1_000_000;
    this.timers = new Map();
    this.nextId = 1;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }

  setInterval(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn, every: ms });
    return id;
  }

  clearTimeout(id: number) {
    this.timers.delete(id);
  }

  clearInterval(id: number) {
    this.timers.delete(id);
  }

  /** Runs every timer due within `ms`, in order, moving the clock as it goes. */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let next: [number, Timer] | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && (!next || timer.at < next[1].at)) next = [id, timer];
      }
      if (!next) break;
      const [id, timer] = next;
      this.t = timer.at;
      if (timer.every) timer.at += timer.every;
      else this.timers.delete(id);
      timer.fn();
    }
    this.t = end;
  }
}
