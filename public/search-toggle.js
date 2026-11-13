(() => {
  const searchIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg>';
  const closeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>';

  function enhanceSelect(select) {
    if (select.dataset.modernized === 'true') return;
    select.dataset.modernized = 'true';
    const wrapper = document.createElement('div');
    wrapper.className = 'modern-select';
    select.parentNode.insertBefore(wrapper, select);
    wrapper.append(select);
    select.classList.add('modern-select-native');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'modern-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', select.getAttribute('aria-label') || select.labels?.[0]?.textContent || 'Choose filter');
    const menu = document.createElement('div');
    menu.className = 'modern-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    const id = select.id || `modern-select-${Math.random().toString(36).slice(2)}`;
    menu.id = `${id}-options`;
    trigger.setAttribute('aria-controls', menu.id);

    const render = () => {
      const chosen = select.options[select.selectedIndex];
      trigger.innerHTML = `<span>${chosen?.textContent || 'Choose'}</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7 5 5 5-5"></path></svg>`;
      menu.replaceChildren(...[...select.options].filter(option => !option.disabled).map(option => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'modern-select-option';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(option.value === select.value));
        item.textContent = option.textContent;
        item.addEventListener('click', () => {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          close();
        });
        return item;
      }));
    };
    const close = () => {
      wrapper.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      menu.hidden = true;
    };
    const open = () => {
      render();
      wrapper.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      menu.hidden = false;
      menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    };
    trigger.addEventListener('click', () => trigger.getAttribute('aria-expanded') === 'true' ? close() : open());
    trigger.addEventListener('keydown', event => {
      if (event.key === 'Escape') close();
      if (event.key === 'ArrowDown' && trigger.getAttribute('aria-expanded') !== 'true') { event.preventDefault(); open(); }
    });
    select.addEventListener('change', render);
    document.addEventListener('click', event => { if (!wrapper.contains(event.target)) close(); });
    wrapper.append(trigger, menu);
    render();

    new MutationObserver(render).observe(select, { childList: true, subtree: true, attributes: true });
  }

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

  document.querySelectorAll('[data-modern-select]').forEach(enhanceSelect);
})();
