function nowMs() {
  return Date.now();
}

export class FixedWindowRateLimiter {
  constructor({ windowMs, maxPerWindow }) {
    this.windowMs = windowMs;
    this.maxPerWindow = maxPerWindow;
    /** @type {Map<string, { start: number, count: number }>} */
    this.state = new Map();
  }

  /**
   * @returns {{ ok: true } | { ok: false, retryAfterMs: number }}
   */
  take(key) {
    if (this.maxPerWindow <= 0) return { ok: true };
    const now = nowMs();
    const current = this.state.get(key);
    if (!current || now - current.start >= this.windowMs) {
      this.state.set(key, { start: now, count: 1 });
      return { ok: true };
    }
    if (current.count >= this.maxPerWindow) {
      const retryAfterMs = Math.max(0, this.windowMs - (now - current.start));
      return { ok: false, retryAfterMs };
    }
    current.count += 1;
    return { ok: true };
  }
}

