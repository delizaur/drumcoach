// Guided tour: a card next to one control at a time, with the rest of the page dimmed around it.

const GAP = 12;    // px between the control and the card
const MARGIN = 12; // px the card keeps from the window's edges
const PAD = 6;     // px of highlight around the control

export class Tour {
  /**
   * @param {Array<{target: () => Element|null, title: string, html: string, onShow?: () => void, onHide?: () => void}>} steps
   */
  constructor(steps, { onEnd } = {}) {
    this.steps = steps;
    this.onEnd = onEnd;
    this.k = -1;
    this.place = this.place.bind(this);
    this.onKey = this.onKey.bind(this);
  }

  get active() { return this.k >= 0; }

  start() {
    if (this.active) return;
    this.build();
    window.addEventListener('resize', this.place);
    window.addEventListener('scroll', this.place, true);
    window.addEventListener('keydown', this.onKey, true);
    this.show(0);
  }

  build() {
    this.blocker = el('div', 'tour-blocker'); // keeps clicks off the page while the tour runs
    this.spot = el('div', 'tour-spot');
    this.card = el('div', 'tour-card');
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-labelledby', 'tourTitle');
    this.card.innerHTML = `
      <div class="tour-count" id="tourCount"></div>
      <h2 id="tourTitle"></h2>
      <div class="tour-text" id="tourText"></div>
      <div class="tour-actions">
        <button class="btn ghost small" type="button" data-act="skip">Skip tour</button>
        <button class="btn primary small" type="button" data-act="next">Next</button>
      </div>`;
    this.card.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'skip') this.end();
      else if (act === 'next') this.next();
    });
    document.body.append(this.blocker, this.spot, this.card);
  }

  show(k) {
    this.steps[this.k]?.onHide?.();
    this.k = k;
    const step = this.steps[k];
    step.onShow?.();
    this.card.querySelector('#tourCount').textContent = `${k + 1} / ${this.steps.length}`;
    this.card.querySelector('#tourTitle').textContent = step.title;
    this.card.querySelector('#tourText').innerHTML = step.html;
    this.card.querySelector('[data-act=next]').textContent = k === this.steps.length - 1 ? 'Finish' : 'Next';
    const target = this.target();
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    this.place();
    this.card.querySelector('[data-act=next]').focus({ preventScroll: true });
  }

  next() {
    if (this.k + 1 < this.steps.length) this.show(this.k + 1);
    else this.end();
  }

  end() {
    if (!this.active) return;
    this.steps[this.k]?.onHide?.();
    this.k = -1;
    window.removeEventListener('resize', this.place);
    window.removeEventListener('scroll', this.place, true);
    window.removeEventListener('keydown', this.onKey, true);
    this.blocker.remove();
    this.spot.remove();
    this.card.remove();
    this.onEnd?.();
  }

  onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.end(); return; }
    // keys meant for the page (like the keyboard drums) wait until the tour is over
    if (!this.card.contains(e.target) && e.key !== 'Tab') { e.preventDefault(); e.stopPropagation(); }
  }

  /** The step's control, if it's on screen (some are hidden on small screens). */
  target() {
    const t = this.steps[this.k]?.target();
    return t && t.getClientRects().length ? t : null;
  }

  /** Puts the highlight on the control and the card next to it: below, above, right or left, whichever fits first. */
  place() {
    if (!this.active) return;
    const t = this.target(), vw = innerWidth, vh = innerHeight;
    const cw = this.card.offsetWidth, ch = this.card.offsetHeight;
    if (!t) {
      this.spot.hidden = true;
      this.card.style.left = `${(vw - cw) / 2}px`;
      this.card.style.top = `${Math.max(MARGIN, (vh - ch) / 2)}px`;
      return;
    }
    const r = t.getBoundingClientRect();
    this.spot.hidden = false;
    Object.assign(this.spot.style, {
      left: `${r.left - PAD}px`, top: `${r.top - PAD}px`, width: `${r.width + 2 * PAD}px`, height: `${r.height + 2 * PAD}px`,
    });
    const clampX = x => Math.min(Math.max(MARGIN, x), vw - cw - MARGIN);
    const clampY = y => Math.min(Math.max(MARGIN, y), vh - ch - MARGIN);
    const options = [
      [r.bottom + PAD + GAP + ch <= vh - MARGIN, () => [clampX(r.left + r.width / 2 - cw / 2), r.bottom + PAD + GAP]],
      [r.top - PAD - GAP - ch >= MARGIN, () => [clampX(r.left + r.width / 2 - cw / 2), r.top - PAD - GAP - ch]],
      [r.right + PAD + GAP + cw <= vw - MARGIN, () => [r.right + PAD + GAP, clampY(r.top + r.height / 2 - ch / 2)]],
      [r.left - PAD - GAP - cw >= MARGIN, () => [r.left - PAD - GAP - cw, clampY(r.top + r.height / 2 - ch / 2)]],
    ];
    // beside a control in the sidebar, so the card doesn't cover what's below it
    if (r.right < vw / 3) options.unshift(options[2]);
    const [x, y] = (options.find(([fits]) => fits)?.[1] ?? (() => [clampX((vw - cw) / 2), vh - ch - MARGIN]))();
    this.card.style.left = `${x}px`;
    this.card.style.top = `${y}px`;
  }
}

function el(tag, cls) {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
