export class ShuffleQueue {
  constructor({
    enabled = true,
    getQueueIndices,
    getQueueVersion,
    getCurrentIndex,
  } = {}) {
    this.enabled = !!enabled;
    this.getQueueIndices = typeof getQueueIndices === 'function' ? getQueueIndices : () => [];
    this.getQueueVersion = typeof getQueueVersion === 'function' ? getQueueVersion : () => 0;
    this.getCurrentIndex = typeof getCurrentIndex === 'function' ? getCurrentIndex : () => -1;

    this.bag = [];
    this.bagVersion = -1;
    this.history = [];
    this.historyPos = -1;
  }

  isEnabled() {
    return !!this.enabled;
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    this.resetAll();
  }

  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  resetBag() {
    const queue = this.getQueueIndices();
    const currentIndex = this.getCurrentIndex();
    const remaining = (queue || []).filter((idx) => idx !== currentIndex);

    // Fisher–Yates shuffle.
    for (let i = remaining.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = remaining[i];
      remaining[i] = remaining[j];
      remaining[j] = tmp;
    }

    this.bag = remaining;
    this.bagVersion = this.getQueueVersion();
  }

  resetHistory() {
    this.history = [];
    this.historyPos = -1;
  }

  resetAll() {
    this.bag = [];
    this.bagVersion = -1;
    this.resetHistory();
  }

  onQueueChanged() {
    // Shuffle bag resets lazily via version mismatch.
    this.resetHistory();
  }

  notePlayed(idx) {
    if (!this.enabled) return;
    if (this.bagVersion !== this.getQueueVersion()) return;
    const pos = this.bag.indexOf(idx);
    if (pos >= 0) {
      this.bag.splice(pos, 1);
    }
  }

  recordHistory(idx, { suppress = false } = {}) {
    if (!this.enabled) return;
    if (suppress) return;
    if (typeof idx !== 'number' || idx < 0) return;

    // If the user went back and then plays a new track, discard the "forward" part.
    if (this.historyPos >= 0 && this.historyPos < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyPos + 1);
    }

    const last = this.history.length ? this.history[this.history.length - 1] : null;
    if (last === idx) {
      this.historyPos = this.history.length - 1;
      return;
    }

    this.history.push(idx);
    this.historyPos = this.history.length - 1;
  }

  next() {
    if (!this.enabled) return { index: -1, fromHistory: false };

    // If user previously went back, go forward through history first.
    if (this.historyPos >= 0 && this.historyPos < this.history.length - 1) {
      this.historyPos += 1;
      return { index: this.history[this.historyPos], fromHistory: true };
    }

    const queue = this.getQueueIndices();
    if (!queue || !queue.length) return { index: -1, fromHistory: false };

    if (this.bagVersion !== this.getQueueVersion()) {
      this.resetBag();
    }
    if (!this.bag.length) {
      this.resetBag();
    }
    if (!this.bag.length) return { index: -1, fromHistory: false };

    return { index: this.bag.pop(), fromHistory: false };
  }

  prev() {
    if (!this.enabled) return -1;
    if (this.historyPos > 0) {
      this.historyPos -= 1;
      return this.history[this.historyPos];
    }
    return -1;
  }
}
