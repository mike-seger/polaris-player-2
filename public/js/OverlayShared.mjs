export function createOverlayCloseButton(options = {}) {
  const { onClick } = options;
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', 'Close overlay');
  button.style.background = '#28344d';
  button.style.color = '#f5f7fa';
  button.style.border = '1px solid #394150';
  button.style.borderRadius = '4px';
  button.style.padding = '0.35rem';
  button.style.cursor = 'pointer';
  button.style.fontSize = '0';
  button.style.display = 'inline-flex';
  button.style.alignItems = 'center';
  button.style.justifyContent = 'center';

  const icon = document.createElement('span');
  icon.className = 'icon close';
  icon.textContent = 'close';
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);

  button.addEventListener('click', (event) => {
    event.preventDefault();
    if (typeof onClick === 'function') {
      onClick(event);
    }
  });

  return button;
}

export function isTextInputActive() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = (el.getAttribute('type') || '').toLowerCase();
    return type === '' || type === 'text' || type === 'search' || type === 'email' || type === 'number'
      || type === 'password' || type === 'url' || type === 'tel';
  }
  return !!el.isContentEditable;
}

export function scrollFirstSelectedOptionIntoView(optionsEl) {
  if (!optionsEl) return;
  const labels = Array.from(optionsEl.querySelectorAll('label.track-details-option'));
  for (const label of labels) {
    if (label.dataset && label.dataset.role === 'all') continue;
    const input = label.querySelector('input[type="checkbox"]');
    if (input && input.checked) {
      // Prefer manual container scroll to avoid browser quirks when overlays flip
      // from display:none -> display:flex.
      try {
        const containerRect = optionsEl.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        const sticky = optionsEl.querySelector('label.track-details-option[data-role="all"]');
        const stickyHeight = sticky ? sticky.getBoundingClientRect().height : 0;
        const desiredTop = labelRect.top - containerRect.top - stickyHeight - 6;
        optionsEl.scrollTop += desiredTop;
      } catch (e) {
        label.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
  }
  optionsEl.scrollTop = 0;
}

export function scheduleScrollFirstSelectedOptionIntoView(optionsEl) {
  if (!optionsEl) return;
  // Two RAFs ensures the overlay has been displayed and laid out.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scrollFirstSelectedOptionIntoView(optionsEl);
    });
  });
}

export function installOverlayListKeydownHandler(options = {}) {
  const {
    isOverlayVisible = () => false,
    getOptionsEl = () => null,
    filterInputEl = null,
    onTypeaheadChar = () => {},
  } = options;

  const allowedChar = /[a-zA-Z0-9\u0400-\u04FF\s\-_.]/;

  const handler = (event) => {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!isOverlayVisible()) return;

    // Don't hijack typing in the main filter input.
    if (filterInputEl && document.activeElement === filterInputEl) return;

    const optionsEl = getOptionsEl();
    if (!optionsEl) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      optionsEl.scrollBy({ top: 32, behavior: 'auto' });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      optionsEl.scrollBy({ top: -32, behavior: 'auto' });
      return;
    }
    if (event.key === 'PageDown') {
      event.preventDefault();
      optionsEl.scrollBy({ top: Math.max(64, Math.floor(optionsEl.clientHeight * 0.9)), behavior: 'auto' });
      return;
    }
    if (event.key === 'PageUp') {
      event.preventDefault();
      optionsEl.scrollBy({ top: -Math.max(64, Math.floor(optionsEl.clientHeight * 0.9)), behavior: 'auto' });
      return;
    }

    const key = event.key;
    if (!key || key.length !== 1) return;
    if (isTextInputActive()) return;

    if (!allowedChar.test(key)) return;

    onTypeaheadChar(key);
  };

  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}

// Temporary global shim for legacy call sites.
if (typeof window !== 'undefined') {
  const shared = window.OverlayShared || {};
  shared.createOverlayCloseButton = createOverlayCloseButton;
  window.OverlayShared = shared;
}
