(() => {
  const init = () => {
    const box = document.querySelector('#checkout-coupon-box');
    const input = document.querySelector('#checkout-coupon-code');
    const apply = document.querySelector('#checkout-coupon-apply');
    const remove = document.querySelector('#checkout-coupon-remove');
    const hidden = document.querySelector('#checkout-coupon-hidden');
    const message = document.querySelector('#checkout-coupon-message');
    const result = document.querySelector('#checkout-coupon-total');
    const form = document.querySelector('#checkout-form');
    if (!box || !input || !apply || !form) return;

    const serviceId = Number(new URLSearchParams(location.search).get('serviceId')) || 0;
    let applied = null;
    const money = value => '₹' + Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const say = (text, ok = false) => {
      message.textContent = text;
      message.classList.toggle('is-success', ok);
      message.classList.toggle('is-error', Boolean(text) && !ok);
    };
    const clearBookingDiscount = () => {
      const price = document.querySelector('#booking-summary-price');
      const source = document.querySelector('#checkout-extras-total');
      if (price && source) price.innerHTML = source.innerHTML;
      const reviewTotal = document.querySelector('[data-review="total"]');
      const sourceTotal = source?.querySelector('.booking-price-summary-grand strong');
      if (reviewTotal && sourceTotal) reviewTotal.textContent = sourceTotal.textContent;
    };
    const syncBookingDiscount = () => {
      if (!serviceId || !applied) return;
      const price = document.querySelector('#booking-summary-price');
      if (!price) return;
      const grand = price.querySelector('.booking-price-summary-grand');
      if (!grand) return;
      const existing = price.querySelector('.coupon-summary-discount');
      const amount = grand.querySelector('strong');
      if (existing?.dataset.code === String(applied.code || '') && amount?.textContent === money(applied.total)) {
        const reviewTotal = document.querySelector('[data-review="total"]');
        if (reviewTotal) reviewTotal.textContent = money(applied.total);
        return;
      }
      existing?.remove();
      const row = document.createElement('div');
      row.className = 'booking-price-summary-row coupon-summary-discount';
      row.dataset.code = String(applied.code || '');
      row.innerHTML = '<span>Coupon · ' + String(applied.code || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) + '</span><strong>−' + money(applied.discount) + '</strong>';
      grand.before(row);
      if (amount) amount.textContent = money(applied.total);
      const reviewTotal = document.querySelector('[data-review="total"]');
      if (reviewTotal) reviewTotal.textContent = money(applied.total);
    };
    const moveToBookingSummary = () => {
      const mount = document.querySelector('#booking-summary-coupon-mount');
      if (!serviceId || !mount || box.parentElement === mount) return false;
      mount.append(box);
      syncBookingDiscount();
      return true;
    };
    if (!serviceId) {
      const productMount = document.querySelector('#checkout-coupon-mount');
      if (productMount) productMount.append(box);
    } else {
      const observer = new MutationObserver(() => {
        if (moveToBookingSummary()) observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      moveToBookingSummary();
    }

    const requestBody = () => {
      if (serviceId) {
        const dates = [...document.querySelectorAll('input[name="bookingDate"]')].map(el => el.value).filter(Boolean);
        const extras = [...document.querySelectorAll('[data-extra-card]')]
          .filter(card => card.querySelector('[name="bookingExtra"]')?.checked)
          .map(card => ({ id: Number(card.dataset.extraCard), quantity: Math.max(1, Number(card.querySelector('[data-extra-quantity]')?.value) || 1) }));
        return { context: 'bookings', serviceId, dates, extras };
      }
      let items = [];
      try {
        items = JSON.parse(localStorage.getItem('lumekh_cart') || '[]').map(item => ({
          productId: Number(item.productId), variantId: Number(item.variantId) || null, quantity: Number(item.quantity) || 1
        }));
      } catch (_) {}
      return { context: 'products', items };
    };
    const reset = () => {
      applied = null;
      hidden.value = '';
      result.hidden = true;
      result.innerHTML = '';
      remove.hidden = true;
      apply.hidden = false;
      input.disabled = false;
      clearBookingDiscount();
    };

    apply.addEventListener('click', async () => {
      const code = input.value.trim().toUpperCase();
      if (!code) { say('Enter a coupon code.'); input.focus(); return; }
      apply.disabled = true;
      say('Checking coupon…');
      try {
        const response = await fetch('/api/coupons/validate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...requestBody(), code })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.message || 'This coupon could not be applied.');
        applied = data;
        hidden.value = data.code;
        input.value = data.code;
        input.disabled = true;
        apply.hidden = true;
        remove.hidden = false;
        result.hidden = false;
        result.innerHTML = '<div class="coupon-result-row"><span>Discount</span><strong>−' + money(data.discount) + '</strong></div><div class="coupon-result-total"><span>Estimated total</span><strong>' + money(data.total) + '</strong></div>';
        syncBookingDiscount();
        say('Coupon applied to your ' + (serviceId ? 'booking.' : 'order.'), true);
      } catch (error) {
        reset();
        say(error.message || 'This coupon could not be applied.');
      } finally { apply.disabled = false; }
    });
    remove.addEventListener('click', () => { reset(); input.value = ''; say('Coupon removed.'); });

    const selectionChanged = event => {
      if (applied && event.target?.name !== 'couponCode') {
        reset();
        say('Your selection changed. Apply the coupon again to update the discount.');
      }
    };
    form.addEventListener('input', selectionChanged);
    form.addEventListener('change', selectionChanged);
    window.addEventListener('lumekh:cart-updated', () => {
      if (applied) { reset(); say('Your basket changed. Apply the coupon again.'); }
    });
    if (serviceId) {
      const summaryObserver = new MutationObserver(() => { moveToBookingSummary(); syncBookingDiscount(); });
      summaryObserver.observe(document.body, { childList: true, subtree: true });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
