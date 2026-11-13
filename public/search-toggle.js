(() => {
  const searchIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg>';
  const closeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>';

  document.querySelectorAll('.search-toggle-button').forEach(button => {
    const control = button.closest('.search-control');
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    const field = panel?.querySelector('input[type="search"]');
    if (!control || !panel || !field) return;

    const setOpen = open => {
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', open ? 'Close search' : 'Open search');
      button.innerHTML = open ? closeIcon : searchIcon;
      control.classList.toggle('is-open', open);
      panel.hidden = !open;
      if (open) field.focus();
    };

    button.addEventListener('click', () => setOpen(button.getAttribute('aria-expanded') !== 'true'));
    field.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        button.focus({ preventScroll: true });
      }
    });
    document.addEventListener('click', event => {
      if (button.getAttribute('aria-expanded') === 'true' && !control.contains(event.target)) setOpen(false);
    });
    setOpen(false);
  });
})();
