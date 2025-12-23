export function createAlert(options = {}) {
  const { overlayEl = null, messageEl = null, closeBtn = null } = options;
  let lastFocusedElement = null;

  function isVisible() {
    return !!overlayEl?.classList?.contains('visible');
  }

  function hide() {
    if (!overlayEl) return;
    overlayEl.classList.remove('visible');
    overlayEl.style.display = '';
    overlayEl.setAttribute('aria-hidden', 'true');
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
      lastFocusedElement.focus({ preventScroll: true });
    }
    lastFocusedElement = null;
  }

  function show(message) {
    if (!overlayEl || !messageEl || !closeBtn) {
      window.alert(typeof message === 'string' ? message : JSON.stringify(message, null, 2));
      return;
    }
    const formatted = typeof message === 'string' ? message : JSON.stringify(message, null, 2);
    messageEl.textContent = formatted;
    messageEl.scrollTop = 0;
    lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayEl.style.display = 'flex';
    overlayEl.classList.add('visible');
    overlayEl.setAttribute('aria-hidden', 'false');
    closeBtn.focus({ preventScroll: true });
  }

  function handleEscape(event) {
    if (event?.key !== 'Escape') return false;
    if (!isVisible()) return false;
    hide();
    event.preventDefault();
    return true;
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', hide);
  }

  if (overlayEl) {
    overlayEl.addEventListener('click', (event) => {
      if (event.target === overlayEl) {
        hide();
      }
    });
  }

  return {
    isVisible,
    show,
    hide,
    handleEscape
  };
}
