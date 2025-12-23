export class SettingsStore {
  constructor(storageKey, { onChange } = {}) {
    if (!storageKey || typeof storageKey !== 'string') {
      throw new Error('SettingsStore requires a string storageKey');
    }
    this.storageKey = storageKey;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.value = {};
  }

  load() {
    this.value = this._safeRead();
    return this.value;
  }

  get() {
    return this.value;
  }

  patch(patch) {
    this.value = Object.assign({}, this.value, patch);
    this._safeWrite(this.value);
    this._safeNotifyChange();
    return this.value;
  }

  replace(nextValue) {
    this.value = (nextValue && typeof nextValue === 'object') ? nextValue : {};
    this._safeWrite(this.value);
    this._safeNotifyChange();
    return this.value;
  }

  reset() {
    this.value = {};
    this._safeRemove();
    this._safeNotifyChange();
    return this.value;
  }

  snapshot() {
    try {
      return structuredClone(this.value);
    } catch {
      try {
        return JSON.parse(JSON.stringify(this.value));
      } catch {
        return {};
      }
    }
  }

  _safeRead() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      console.warn('Failed to load settings:', error);
      return {};
    }
  }

  _safeWrite(value) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(value));
    } catch (error) {
      console.warn('Failed to save settings:', error);
    }
  }

  _safeRemove() {
    try {
      localStorage.removeItem(this.storageKey);
    } catch (error) {
      console.warn('Failed to clear stored settings:', error);
      throw error;
    }
  }

  _safeNotifyChange() {
    try {
      this.onChange();
    } catch (error) {
      console.warn('Settings overlay update failed:', error);
    }
  }
}
