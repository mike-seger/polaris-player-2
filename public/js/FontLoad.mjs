export function initIconFontReadyClass(options = {}) {
  const {
    timeoutMs = 1500,
    fontSpec = "1em 'Material Icons Round-Regular'",
    className = 'icons-ready'
  } = options;

  function markReady() {
    document.documentElement.classList.add(className);
  }

  try {
    if (document.fonts && typeof document.fonts.load === 'function') {
      Promise.race([
        document.fonts.load(fontSpec),
        new Promise((resolve) => setTimeout(resolve, timeoutMs))
      ]).then(markReady, markReady);
    } else {
      setTimeout(markReady, 0);
    }
  } catch (e) {
    markReady();
  }
}
