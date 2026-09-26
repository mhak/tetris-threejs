// Shared test helpers for the online code.

/** Lets queued loopback messages (microtasks) arrive. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A clock whose timers only run when the test advances time. */
export class FakeClock {
  constructor() {
    this.t = 1_000_000;
    this.timers = new Map();
    this.nextId = 1;
  }

  now() {
    return this.t;
  }

  setTimeout(fn, ms) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }

  setInterval(fn, ms) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn, every: ms });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  clearInterval(id) {
    this.timers.delete(id);
  }

  /** Runs every timer due within `ms`, in order, moving the clock as it goes. */
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      let next = null;
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
