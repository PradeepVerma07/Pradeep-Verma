/**
 * Loomhaus storefront behaviour. Vanilla JavaScript, no dependencies.
 *
 *  - LH.cart            Cart Ajax API + Section Rendering API wrapper, auto-add rule
 *  - <lh-cart-drawer>   Drawer open/close, line quantity changes
 *  - <lh-quick-view>    Fetches /products/:handle?section_id=lh-quick-view into a modal / bottom sheet
 *  - <lh-product-form>  Variant selection, price, ribbons, sold-out sizes, gallery, qty, add to cart, offers
 */
(() => {
  'use strict';

  const config = window.Loomhaus || { routes: {}, moneyFormat: '{{amount}}' };
  // Figma shows INR as "₹389.55"; the store format is "Rs. {{amount}}" (see snippets/lh-money.liquid).
  if (config.currency === 'INR') config.moneyFormat = '\u20B9{{amount}}';
  const routes = Object.assign(
    { root: '/', cartAdd: '/cart/add.js', cartChange: '/cart/change.js', cart: '/cart.js' },
    config.routes
  );
  const DRAWER_SECTION = 'lh-cart-drawer';
  const GIFT_DECLINED_KEY = 'lh-gift-declined';
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';

  /* ------------------------------------------------------------------ utils */

  const formatMoney = (cents, format = config.moneyFormat) => {
    const value = Number(cents) / 100;
    const withDelimiters = (n, decimals, thousands = ',', decimal = '.') => {
      const [whole, frac] = n.toFixed(decimals).split('.');
      return whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousands) + (frac ? decimal + frac : '');
    };
    return format.replace(/\{\{\s*(\w+)\s*\}\}/, (_, key) => {
      switch (key) {
        case 'amount_no_decimals': return withDelimiters(value, 0);
        case 'amount_with_comma_separator': return withDelimiters(value, 2, '.', ',');
        case 'amount_no_decimals_with_comma_separator': return withDelimiters(value, 0, '.', ',');
        default: return withDelimiters(value, 2);
      }
    });
  };

  const announce = (message) => {
    const region = document.getElementById('LhLiveRegion');
    if (!region) return;
    region.textContent = '';
    window.setTimeout(() => { region.textContent = message; }, 50);
  };

  const fetchJSON = async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.status) {
      const error = new Error(data.description || data.message || 'Something went wrong. Please try again.');
      error.status = response.status;
      throw error;
    }
    return data;
  };

  /** Focus trap + scroll lock shared by the drawer and the quick view. */
  const overlay = {
    stack: [],
    open(el, panel, opener) {
      el.hidden = false;
      // Force a frame so the CSS transition runs.
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
      document.body.classList.add('lh-scroll-locked');
      const entry = { el, panel, opener: opener || document.activeElement };
      entry.onKey = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); el.close ? el.close() : overlay.close(el); }
        if (event.key === 'Tab') overlay.trap(event, panel);
      };
      document.addEventListener('keydown', entry.onKey);
      this.stack.push(entry);
      window.setTimeout(() => (panel.querySelector('[data-lh-autofocus]') || panel).focus({ preventScroll: true }), 60);
    },
    close(el) {
      const index = this.stack.findIndex((entry) => entry.el === el);
      if (index === -1) return;
      const [entry] = this.stack.splice(index, 1);
      document.removeEventListener('keydown', entry.onKey);
      el.classList.remove('is-open');
      window.setTimeout(() => { if (!el.classList.contains('is-open')) el.hidden = true; }, 350);
      if (!this.stack.length) document.body.classList.remove('lh-scroll-locked');
      if (entry.opener && document.contains(entry.opener)) entry.opener.focus({ preventScroll: true });
    },
    isOpen(el) { return this.stack.some((entry) => entry.el === el); },
    trap(event, panel) {
      const items = [...panel.querySelectorAll(FOCUSABLE)].filter((node) => node.offsetParent !== null);
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    },
  };

  /* ------------------------------------------------------------------ cart */

  const cart = {
    busy: false,

    drawer() { return document.querySelector('lh-cart-drawer'); },

    async add(items) {
      await fetchJSON(routes.cartAdd, { method: 'POST', body: JSON.stringify({ items }) });
      return this.sync();
    },

    async change(line, quantity) {
      await fetchJSON(routes.cartChange, { method: 'POST', body: JSON.stringify({ id: line, quantity }) });
      return this.sync();
    },

    /**
     * Applies the auto-add rule, then re-renders the drawer and the header count.
     * Returns the final cart JSON.
     */
    async sync() {
      let state = await fetchJSON(routes.cart);
      state = await this.applyAutoAdd(state);
      await this.render(state);
      return state;
    },

    async applyAutoAdd(state) {
      const drawer = this.drawer();
      const giftVariant = Number(drawer?.dataset.giftVariant);
      if (!giftVariant) return state;

      const triggers = (drawer.dataset.triggerValues || '')
        .split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
      if (!triggers.length) return state;

      const isGift = (item) => item.properties && item.properties._auto_added === 'true';
      const optionValues = (item) => (item.options_with_values || []).map((o) => String(o.value).toLowerCase());
      const hasTrigger = state.items.some((item) => !isGift(item) && triggers.every((t) => optionValues(item).includes(t)));
      const gift = state.items.find(isGift);
      const declined = sessionStorage.getItem(GIFT_DECLINED_KEY) === '1';

      let changed = false;
      if (hasTrigger && !gift && !declined) {
        await fetchJSON(routes.cartAdd, {
          method: 'POST',
          body: JSON.stringify({ items: [{ id: giftVariant, quantity: 1, properties: { _auto_added: 'true' } }] }),
        }).catch(() => {}); // Gift sold out: keep the shopper's cart as it is.
        changed = true;
      } else if (!hasTrigger && gift) {
        await fetchJSON(routes.cartChange, { method: 'POST', body: JSON.stringify({ id: gift.key, quantity: 0 }) });
        changed = true;
      } else if (gift && gift.quantity !== 1) {
        await fetchJSON(routes.cartChange, { method: 'POST', body: JSON.stringify({ id: gift.key, quantity: 1 }) });
        changed = true;
      }
      if (!hasTrigger) sessionStorage.removeItem(GIFT_DECLINED_KEY);

      return changed ? fetchJSON(routes.cart) : state;
    },

    async render(state) {
      const response = await fetch(`${routes.root.replace(/\/$/, '')}/?sections=${DRAWER_SECTION}`);
      const sections = await response.json();
      const html = sections[DRAWER_SECTION];
      if (html) {
        const fresh = new DOMParser().parseFromString(html, 'text/html').querySelector('lh-cart-drawer');
        const current = this.drawer();
        if (fresh && current) {
          current.querySelector('.lh-drawer__panel').innerHTML = fresh.querySelector('.lh-drawer__panel').innerHTML;
          current.dataset.giftVariant = fresh.dataset.giftVariant;
        }
      }
      document.querySelectorAll('[data-lh-cart-count]').forEach((badge) => {
        badge.textContent = state.item_count;
        badge.hidden = state.item_count === 0;
        const link = badge.closest('.lh-cart-icon');
        if (link) {
          link.setAttribute('aria-label', `Open cart, ${state.item_count} items`);
          link.classList.remove('is-bumped');
          void link.offsetWidth;
          link.classList.add('is-bumped');
        }
      });
      document.dispatchEvent(new CustomEvent('lh:cart:updated', { detail: state }));
    },
  };

  /* ------------------------------------------------------------------ drawer */

  class LhCartDrawer extends HTMLElement {
    connectedCallback() {
      this.addEventListener('click', (event) => {
        if (event.target.closest('[data-lh-close]')) {
          const link = event.target.closest('a[href^="#"]');
          this.close();
          if (!link) event.preventDefault();
          return;
        }
        const change = event.target.closest('[data-lh-line-change]');
        if (change && !change.disabled) this.changeLine(change);
      });

      document.addEventListener('click', (event) => {
        const opener = event.target.closest('[data-lh-cart-open]');
        if (!opener) return;
        event.preventDefault();
        this.open(opener);
      });
    }

    get panel() { return this.querySelector('.lh-drawer__panel'); }

    open(opener) {
      if (overlay.isOpen(this)) return;
      overlay.open(this, this.panel, opener);
    }

    close() { overlay.close(this); }

    async changeLine(button) {
      const line = button.closest('[data-line-key]');
      if (!line) return;
      const quantity = Number(button.dataset.lhLineChange);
      if (quantity === 0 && line.hasAttribute('data-auto-added')) sessionStorage.setItem(GIFT_DECLINED_KEY, '1');
      this.classList.add('is-busy');
      try {
        await cart.change(line.dataset.lineKey, quantity);
        announce(quantity === 0 ? 'Item removed from cart' : 'Cart updated');
      } catch (error) {
        announce(error.message);
        await cart.sync().catch(() => {});
      } finally {
        this.classList.remove('is-busy');
        this.panel.focus({ preventScroll: true });
      }
    }
  }

  /* ------------------------------------------------------------------ quick view */

  class LhQuickView extends HTMLElement {
    connectedCallback() {
      this.content = this.querySelector('[data-lh-quick-view-content]');
      this.dialog = this.querySelector('.lh-quick-view__dialog');
      this.cache = new Map();

      this.addEventListener('click', (event) => {
        if (event.target.closest('[data-lh-close]')) { event.preventDefault(); this.close(); }
      });

      document.addEventListener('click', (event) => {
        const trigger = event.target.closest('[data-lh-quick-view]');
        if (!trigger) return;
        event.preventDefault();
        this.open(trigger.dataset.lhQuickView, trigger);
      });

      // Mobile bottom sheet: drag the handle down to dismiss.
      let startY = null;
      this.dialog.addEventListener('touchstart', (event) => {
        startY = this.dialog.scrollTop <= 0 ? event.touches[0].clientY : null;
      }, { passive: true });
      this.dialog.addEventListener('touchmove', (event) => {
        if (startY === null) return;
        const delta = Math.max(0, event.touches[0].clientY - startY);
        this.dialog.style.transform = delta ? `translateY(${delta}px)` : '';
      }, { passive: true });
      this.dialog.addEventListener('touchend', (event) => {
        if (startY === null) return;
        const delta = event.changedTouches[0].clientY - startY;
        this.dialog.style.transform = '';
        startY = null;
        if (delta > 120) this.close();
      });
    }

    async open(productUrl, opener) {
      this.classList.add('is-loading');
      this.content.innerHTML = '';
      overlay.open(this, this.dialog, opener);
      try {
        if (!this.cache.has(productUrl)) {
          const url = `${productUrl}${productUrl.includes('?') ? '&' : '?'}section_id=lh-quick-view`;
          const response = await fetch(url);
          if (!response.ok) throw new Error('Could not load this product.');
          this.cache.set(productUrl, await response.text());
        }
        const doc = new DOMParser().parseFromString(this.cache.get(productUrl), 'text/html');
        const form = doc.querySelector('lh-product-form');
        this.content.replaceChildren(document.importNode(form, true));
        const title = this.content.querySelector('.lh-qv__title');
        if (title) this.dialog.setAttribute('aria-labelledby', title.id);
        this.content.querySelector('[data-lh-close]')?.setAttribute('data-lh-autofocus', '');
        this.dialog.focus({ preventScroll: true });
      } catch (error) {
        this.content.innerHTML = `<p class="lh-qv" role="alert">${error.message}</p>`;
      } finally {
        this.classList.remove('is-loading');
      }
    }

    close() { overlay.close(this); }
  }

  /* ------------------------------------------------------------------ quantity */

  class LhQuantity extends HTMLElement {
    connectedCallback() {
      this.input = this.querySelector('[data-lh-qty-input]');
      this.display = this.querySelector('[data-lh-qty-display]');
      this.minus = this.querySelector('[data-lh-qty-minus]');
      this.plus = this.querySelector('[data-lh-qty-plus]');
      this.minus.addEventListener('click', () => this.set(this.value - 1));
      this.plus.addEventListener('click', () => this.set(this.value + 1));
      this.set(this.value);
    }

    get value() { return Math.max(1, parseInt(this.input.value, 10) || 1); }

    set(value) {
      const next = Math.min(99, Math.max(1, value));
      this.input.value = next;
      this.display.textContent = String(next).padStart(2, '0');
      this.minus.disabled = next <= 1;
      this.plus.disabled = next >= 99;
      this.dispatchEvent(new CustomEvent('lh:quantity', { bubbles: true, detail: next }));
    }
  }

  /* ------------------------------------------------------------------ product form */

  class LhProductForm extends HTMLElement {
    connectedCallback() {
      if (this.ready) return;
      this.ready = true;
      const json = this.querySelector('[data-lh-product-json]');
      this.product = json ? JSON.parse(json.textContent) : null;
      if (!this.product) return;

      this.colorIndex = this.dataset.colorIndex === '' ? null : Number(this.dataset.colorIndex);
      this.sizeIndex = this.dataset.sizeIndex === '' ? null : Number(this.dataset.sizeIndex);
      this.requireSize = this.dataset.requireSize === 'true' && this.sizeIndex !== null;
      this.form = this.querySelector('[data-lh-add-form]');
      this.variantInput = this.querySelector('[data-lh-variant-id]');
      this.addButton = this.querySelector('[data-lh-add-button]');
      this.addLabel = this.querySelector('[data-lh-add-label]');
      this.error = this.querySelector('[data-lh-error]');

      this.addEventListener('change', (event) => {
        if (event.target.matches('[data-lh-option]')) this.onOptionChange();
      });
      this.form?.addEventListener('submit', (event) => { event.preventDefault(); this.addToCart(); });
      this.querySelector('[data-lh-buy-now]')?.addEventListener('click', () => this.buyNow());
      this.querySelectorAll('[data-lh-offer]').forEach((offer) => offer.addEventListener('click', () => this.copyOffer(offer)));

      this.initGallery();
      this.onOptionChange({ initial: true });
    }

    /** Currently chosen option values (null where nothing is picked yet). */
    selectedOptions() {
      const values = this.product.options.map(() => null);
      this.querySelectorAll('[data-lh-option]').forEach((input) => {
        const index = Number(input.dataset.lhOption);
        if (input.tagName === 'SELECT') {
          if (input.value) values[index] = input.value;
        } else if (input.checked) {
          values[index] = input.value;
        }
      });
      return values;
    }

    findVariant(values) {
      return this.product.variants.find((variant) => variant.options.every((value, i) => values[i] === null || values[i] === value));
    }

    onOptionChange({ initial = false } = {}) {
      const values = this.selectedOptions();
      const complete = values.every((v) => v !== null);
      const variant = complete ? this.findVariant(values) : this.findVariant(values.map((v, i) => (i === this.sizeIndex ? null : v)));
      this.hideError();
      this.updateSizeAvailability(values);
      this.updateRibbons(values);

      if (this.colorIndex !== null) {
        const label = this.querySelector('[data-lh-color-label]');
        if (label && values[this.colorIndex]) label.textContent = values[this.colorIndex].toUpperCase();
      }

      if (variant) {
        if (!initial || !this.requireSize) this.showImage(variant.image_id, !initial);
        this.updatePrice(variant);
      }

      this.currentVariant = complete ? variant : null;
      if (this.variantInput && this.currentVariant) this.variantInput.value = this.currentVariant.id;

      const select = this.querySelector('[data-lh-size-select]');
      if (select) select.classList.toggle('is-placeholder', !select.value);

      const available = Boolean(this.currentVariant && this.currentVariant.available);
      if (this.addButton) {
        this.addButton.disabled = !available;
        if (this.addLabel) {
          this.addLabel.textContent = complete && this.currentVariant && !this.currentVariant.available ? 'SOLD OUT' : 'ADD TO CART';
        }
      }
      const buyNow = this.querySelector('[data-lh-buy-now]');
      if (buyNow) buyNow.disabled = !available;
    }

    /** Sizes with no available variant in the selected colour are disabled (sold-out state). */
    updateSizeAvailability(values) {
      if (this.sizeIndex === null) return;
      const isAvailable = (size) => this.product.variants.some((variant) =>
        variant.available &&
        variant.options[this.sizeIndex] === size &&
        (this.colorIndex === null || values[this.colorIndex] === null || variant.options[this.colorIndex] === values[this.colorIndex])
      );

      this.querySelectorAll(`[data-lh-option="${this.sizeIndex}"]`).forEach((input) => {
        if (input.tagName === 'SELECT') {
          [...input.options].forEach((option) => {
            if (!option.value) return;
            const ok = isAvailable(option.value);
            option.disabled = !ok;
            option.textContent = ok ? option.value : `${option.value} - Sold out`;
          });
          if (input.value && !isAvailable(input.value)) input.value = '';
          return;
        }
        const ok = isAvailable(input.value);
        input.disabled = !ok;
        if (!ok && input.checked) {
          input.checked = false;
          const fallback = [...this.querySelectorAll(`[data-lh-option="${this.sizeIndex}"]`)].find((i) => !i.disabled);
          if (fallback) { fallback.checked = true; values[this.sizeIndex] = fallback.value; } else { values[this.sizeIndex] = null; }
        }
      });
    }

    /** Ribbon text lives on the variant ("Most Ordered", "Best Fit"); show it on its size pill. */
    updateRibbons(values) {
      this.querySelectorAll('[data-lh-ribbon]').forEach((ribbon) => {
        const size = ribbon.dataset.lhRibbon;
        const variant = this.product.variants.find((v) =>
          v.options[this.sizeIndex] === size &&
          (this.colorIndex === null || v.options[this.colorIndex] === values[this.colorIndex])
        ) || this.product.variants.find((v) => v.options[this.sizeIndex] === size && v.ribbon);
        const text = variant && variant.ribbon;
        ribbon.textContent = text || '';
        ribbon.hidden = !text;
      });
    }

    updatePrice(variant) {
      const priceBlock = this.querySelector('[data-lh-price]');
      if (priceBlock) {
        let html = `<span class="lh-price__current">${formatMoney(variant.price)}</span>`;
        if (variant.compare_at_price > variant.price) {
          const saving = Math.round(((variant.compare_at_price - variant.price) * 100) / variant.compare_at_price);
          html += `<s class="lh-price__compare"><span class="lh-visually-hidden">Regular price</span>${formatMoney(variant.compare_at_price)}</s>`;
          html += `<span class="lh-price__save">SAVE ${saving}%</span>`;
        }
        priceBlock.innerHTML = html;
      }
      const qvPrice = this.querySelector('[data-lh-qv-price]');
      if (qvPrice) qvPrice.textContent = formatMoney(variant.price);

      this.querySelectorAll('[data-lh-offer]').forEach((offer) => {
        const percent = Number(offer.dataset.percent) || 0;
        const target = offer.querySelector('[data-lh-offer-price]');
        if (target) target.textContent = formatMoney(Math.round((variant.price * (100 - percent)) / 100));
      });
    }

    /* Gallery (featured product) and single image (quick view) */
    initGallery() {
      this.track = this.querySelector('[data-lh-gallery-track]');
      if (!this.track) return;
      this.slides = [...this.track.children];
      this.prev = this.querySelector('[data-lh-gallery-prev]');
      this.next = this.querySelector('[data-lh-gallery-next]');
      this.prev?.addEventListener('click', () => this.goTo(this.activeIndex - 1));
      this.next?.addEventListener('click', () => this.goTo(this.activeIndex + 1));
      this.querySelectorAll('[data-lh-gallery-thumb]').forEach((thumb) => {
        thumb.addEventListener('click', () => this.showImage(Number(thumb.dataset.lhGalleryThumb), true));
      });
      this.track.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight') { event.preventDefault(); this.goTo(this.activeIndex + 1); }
        if (event.key === 'ArrowLeft') { event.preventDefault(); this.goTo(this.activeIndex - 1); }
      });
      let ticking = false;
      this.track.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          const index = Math.round(this.track.scrollLeft / this.track.clientWidth);
          this.setActive(index);
        });
      }, { passive: true });
      this.activeIndex = 0;
      this.setActive(0);
    }

    goTo(index) {
      if (!this.slides?.length) return;
      const count = this.slides.length;
      const clamped = ((index % count) + count) % count; // arrows loop, as in Figma (both always active)
      this.track.scrollTo({ left: clamped * this.track.clientWidth, behavior: 'smooth' });
      this.setActive(clamped);
    }

    setActive(index) {
      if (!this.slides?.length) return;
      this.activeIndex = Math.max(0, Math.min(this.slides.length - 1, index));
      const id = this.slides[this.activeIndex].dataset.mediaId;
      this.querySelectorAll('[data-lh-gallery-thumb]').forEach((thumb) => {
        thumb.setAttribute('aria-current', thumb.dataset.lhGalleryThumb === id ? 'true' : 'false');
      });
      this.querySelectorAll('[data-lh-gallery-dot]').forEach((dot) => {
        dot.classList.toggle('is-active', dot.dataset.lhGalleryDot === id);
      });
    }

    showImage(mediaId, animate) {
      if (!mediaId) return;
      if (this.track) {
        const index = this.slides.findIndex((slide) => Number(slide.dataset.mediaId) === Number(mediaId));
        if (index === -1) return;
        if (animate) this.goTo(index);
        else { this.track.scrollLeft = index * this.track.clientWidth; this.setActive(index); }
        return;
      }
      const items = this.querySelectorAll('[data-lh-qv-image] [data-media-id]');
      if (![...items].some((item) => Number(item.dataset.mediaId) === Number(mediaId))) return;
      items.forEach((item) => { item.hidden = Number(item.dataset.mediaId) !== Number(mediaId); });
    }

    /* Cart actions */
    quantity() {
      const input = this.querySelector('[name="quantity"]');
      return Math.max(1, parseInt(input?.value, 10) || 1);
    }

    async addToCart() {
      if (!this.currentVariant) {
        this.showError(this.requireSize ? 'Please choose a size.' : 'Please choose your options.');
        return;
      }
      this.setLoading(true);
      try {
        await cart.add([{ id: this.currentVariant.id, quantity: this.quantity() }]);
        announce(`${this.product.title} added to cart`);
        const quickView = this.closest('lh-quick-view');
        if (quickView) quickView.close();
        const drawer = cart.drawer();
        window.setTimeout(() => drawer?.open(document.querySelector('[data-lh-cart-open]')), quickView ? 280 : 0);
      } catch (error) {
        this.showError(error.message);
      } finally {
        this.setLoading(false);
      }
    }

    buyNow() {
      if (!this.currentVariant) { this.showError('Please choose your options.'); return; }
      window.location.href = `${routes.root.replace(/\/$/, '')}/cart/${this.currentVariant.id}:${this.quantity()}`;
    }

    setLoading(loading) {
      if (!this.addButton) return;
      this.addButton.classList.toggle('is-loading', loading);
      this.addButton.setAttribute('aria-busy', String(loading));
      if (loading) this.addButton.disabled = true;
      else this.addButton.disabled = !(this.currentVariant && this.currentVariant.available);
    }

    showError(message) {
      if (!this.error) return;
      this.error.textContent = message;
      this.error.hidden = false;
    }

    hideError() { if (this.error) this.error.hidden = true; }

    async copyOffer(offer) {
      const code = offer.dataset.code;
      try {
        await navigator.clipboard.writeText(code);
      } catch (error) {
        const helper = document.createElement('textarea');
        helper.value = code;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
      }
      offer.classList.add('is-copied');
      announce(`Code ${code} copied`);
      window.clearTimeout(offer._lhTimer);
      offer._lhTimer = window.setTimeout(() => offer.classList.remove('is-copied'), 2000);
    }
  }

  customElements.define('lh-cart-drawer', LhCartDrawer);
  customElements.define('lh-quick-view', LhQuickView);
  customElements.define('lh-quantity', LhQuantity);
  customElements.define('lh-product-form', LhProductForm);

  // Re-check the auto-add rule on load, e.g. after items were added on another page.
  document.addEventListener('DOMContentLoaded', () => {
    const drawer = cart.drawer();
    if (drawer && drawer.dataset.giftVariant && Number(drawer.querySelector('[data-lh-cart-body]')?.dataset.itemCount) > 0) {
      cart.sync().catch(() => {});
    }
  });

  window.LH = { cart, formatMoney };
})();
