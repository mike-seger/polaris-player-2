/**
 * Tiny event emitter with unsubscribe.
 * Designed for adapters/controllers where you want a single `on(event, fn)` API.
 */
export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._map = new Map();
  }

  /**
   * @template T
   * @param {string} event
   * @param {(payload: T) => void} fn
   * @returns {() => void} unsubscribe
   */
  on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    let set = this._map.get(event);
    if (!set) {
      set = new Set();
      this._map.set(event, set);
    }
    set.add(fn);
    return () => { try { set.delete(fn); } catch { /* ignore */ } };
  }

  /** @param {string} event @param {any} payload */
  emit(event, payload) {
    const set = this._map.get(event);
    if (!set || set.size === 0) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); } catch { /* ignore */ }
    }
  }

  clear() { this._map.clear(); }
}
