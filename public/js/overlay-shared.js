(function (global) {
  const shared = global.OverlayShared || {};

  function createOverlayCloseButton(options = {}) {
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

  shared.createOverlayCloseButton = createOverlayCloseButton;
  global.OverlayShared = shared;
})(window);
