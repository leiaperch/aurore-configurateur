import gsap from 'gsap';
import {
  availableOn,
  encodeConfig,
  find,
  formatPrice,
  includedIn,
  listFor,
  monthly,
  normalize,
  priceLines,
  totalPrice,
  type Catalog,
  type Choice,
  type Config,
  type SingleKey,
} from './catalog';

// Interface du configurateur : étapes, nuanciers, options, synthèse, prix animé.
// L'interface ne connaît pas three.js : elle émet une configuration valide, la scène l'applique.

export type Step = 'trim' | 'paint' | 'wheels' | 'interior' | 'options' | 'summary';
const STEPS: Step[] = ['trim', 'paint', 'wheels', 'interior', 'options', 'summary'];
const NEXT_LABEL: Record<Step, string> = {
  trim: 'Choisir la teinte',
  paint: 'Choisir les jantes',
  wheels: "Choisir l'intérieur",
  interior: 'Choisir les options',
  options: 'Voir la synthèse',
  summary: 'Réserver un essai',
};

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;

export class Ui {
  step: Step = 'trim';
  private body = $('#step-body');
  private shown = { total: 0, monthly: 0 };

  constructor(
    private catalog: Catalog,
    public config: Config,
    private hooks: { onChange: (config: Config) => void; onStep: (step: Step) => void }
  ) {
    document.querySelectorAll<HTMLButtonElement>('.steps [data-step]').forEach((b) => {
      b.addEventListener('click', () => this.go(b.dataset.step as Step));
    });
    $('.steps').addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      const i = (STEPS.indexOf(this.step) + dir + STEPS.length) % STEPS.length;
      this.go(STEPS[i]);
      $<HTMLButtonElement>(`.steps [data-step="${STEPS[i]}"]`).focus();
    });
    $('#next').addEventListener('click', () => {
      if (this.step === 'summary') this.openBooking();
      else this.go(STEPS[STEPS.indexOf(this.step) + 1]);
    });
    this.setupBooking();
    this.renderHead();
    this.renderPrice(true);
    this.renderStep();
  }

  go(step: Step) {
    if (step === this.step) return;
    this.step = step;
    this.renderStep();
    this.hooks.onStep(step);
  }

  private set(patch: Partial<Config>) {
    // une option cochée passe en fin de liste : en cas d'incompatibilité, le dernier choix l'emporte
    const { config, notices } = normalize(this.catalog, { ...this.config, ...patch });
    this.config = config;
    notices.forEach((n) => toast(n));
    this.renderHead();
    this.renderPrice();
    this.renderStep(false);
    this.hooks.onChange(config);
  }

  private renderHead() {
    const trim = find(this.catalog.trims, this.config.trim);
    $('#trim-name').textContent = trim.name;
    $('#trim-tagline').textContent = trim.tagline;
    $('#specs').innerHTML = [
      ['Autonomie WLTP', trim.specs.autonomie],
      ['0 à 100 km/h', trim.specs.zeroCent],
      ['Puissance', trim.specs.puissance],
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
      .join('');
  }

  private renderPrice(instant = false) {
    const total = totalPrice(this.catalog, this.config);
    const month = monthly(this.catalog, total);
    const totalEl = $('#price-total');
    const monthEl = $('#price-monthly');
    const draw = () => {
      totalEl.textContent = formatPrice(Math.round(this.shown.total));
      monthEl.textContent = `ou ${formatPrice(Math.round(this.shown.monthly))}/mois*`;
    };
    gsap.killTweensOf(this.shown);
    if (instant) {
      this.shown.total = total;
      this.shown.monthly = month;
      draw();
    } else {
      gsap.to(this.shown, { total, monthly: month, duration: 0.7, ease: 'power2.out', onUpdate: draw });
    }
  }

  private renderStep(animate = true) {
    document.querySelectorAll<HTMLButtonElement>('.steps [data-step]').forEach((b) => {
      const on = b.dataset.step === this.step;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    $('#next').textContent = NEXT_LABEL[this.step];
    const scroll = this.body.scrollTop;
    // le contenu est reconstruit : on retient l'élément focalisé pour le rendre au clavier ensuite
    const focused = this.body.contains(document.activeElement) ? [...this.body.querySelectorAll('button, input')].indexOf(document.activeElement as Element) : -1;
    this.body.innerHTML = '';
    const view = {
      trim: () => this.trimStep(),
      paint: () => this.swatchGroup('paint', 'Teinte'),
      wheels: () => [this.swatchGroup('wheels', 'Jantes'), this.swatchGroup('calipers', 'Étriers de frein')],
      interior: () => this.swatchGroup('interior', 'Sellerie'),
      options: () => this.optionsStep(),
      summary: () => this.summaryStep(),
    }[this.step]();
    for (const el of [view].flat()) this.body.append(el);
    if (animate) this.body.scrollTop = 0;
    else {
      this.body.scrollTop = scroll;
      // pas de ré-animation d'entrée quand seul un choix change
      this.body.querySelectorAll<HTMLElement>(':scope > *').forEach((el) => (el.style.animation = 'none'));
      if (focused >= 0) this.body.querySelectorAll<HTMLElement>('button, input')[focused]?.focus({ preventScroll: true });
    }
  }

  private trimStep() {
    const wrap = el('div', 'group');
    wrap.innerHTML = `<p class="group-title">Version <span>${this.catalog.trims.length} disponibles</span></p>`;
    const list = el('div', 'cards-radio');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Version');
    const base = this.catalog.basePrice;
    for (const trim of this.catalog.trims) {
      const b = el('button', 'trim');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(trim.id === this.config.trim));
      const included = trim.includes?.map((id) => find(this.catalog.options, id).name.toLowerCase()).join(', ');
      b.innerHTML = `
        <strong>${trim.name}</strong><span class="t-price">${formatPrice(base + trim.price)}</span>
        <span class="t-line">${trim.tagline}${included ? `. De série : ${included}` : ''}</span>
        <span class="t-specs">${trim.specs.autonomie} · ${trim.specs.zeroCent} · ${trim.specs.puissance}</span>`;
      b.addEventListener('click', () => this.set({ trim: trim.id }));
      list.append(b);
    }
    wrap.append(list);
    return wrap;
  }

  private swatchGroup(key: SingleKey, title: string) {
    const items = listFor(this.catalog, key);
    const current = find(items, this.config[key]);
    const wrap = el('div', 'group');
    wrap.innerHTML = `<p class="group-title">${title} <span>${items.length} choix</span></p>`;
    const grid = el('div', 'swatches');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', title);
    const name = el('p', 'choice-name');
    const note = el('p', 'choice-note');
    const describe = (c: Choice) => {
      const finish = 'finish' in c ? `, ${String(c.finish).toLowerCase()}` : '';
      name.innerHTML = `${c.name}${finish}<span>${c.price ? `+ ${formatPrice(c.price)}` : 'Inclus'}</span>`;
      note.textContent = availableOn(c, this.config.trim) ? '' : `Disponible en ${this.trimNames(c.trims!)}`;
    };
    for (const item of items) {
      const b = el('button', 'swatch');
      const ok = availableOn(item, this.config.trim);
      b.style.setProperty('--c', item.hex ?? '#ccc');
      if ('finish' in item && item.finish === 'Mat') b.classList.add('matte');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(item.id === current.id));
      b.setAttribute('aria-label', `${item.name}${item.price ? `, plus ${item.price} euros` : ', inclus'}${ok ? '' : ', indisponible sur cette version'}`);
      if (!ok) b.setAttribute('aria-disabled', 'true');
      b.addEventListener('mouseenter', () => describe(item));
      b.addEventListener('focus', () => describe(item));
      b.addEventListener('mouseleave', () => describe(find(items, this.config[key])));
      b.addEventListener('click', () => {
        if (ok) this.set({ [key]: item.id });
        else toast(`${item.name} est réservé aux versions ${this.trimNames(item.trims!)}.`);
      });
      grid.append(b);
    }
    describe(current);
    wrap.append(grid, name, note);
    return wrap;
  }

  private optionsStep() {
    const wrap = el('div', 'group');
    wrap.innerHTML = `<p class="group-title">Options <span>${this.config.options.length} choisie${this.config.options.length > 1 ? 's' : ''}</span></p>`;
    const list = el('div', 'options');
    for (const option of this.catalog.options) {
      const included = includedIn(this.catalog, option.id, this.config.trim);
      const ok = availableOn(option, this.config.trim);
      const checked = included || this.config.options.includes(option.id);
      const row = el('label', `option${included ? ' included' : ''}${ok ? '' : ' disabled'}`);
      const excludes = this.catalog.options.filter((o) => option.excludes?.includes(o.id) || o.excludes?.includes(option.id));
      const noteText = !ok
        ? `Disponible en ${this.trimNames(option.trims!)}`
        : included
          ? `De série en ${find(this.catalog.trims, this.config.trim).name}`
          : excludes.length
            ? `Incompatible avec : ${excludes.map((o) => o.name.toLowerCase()).join(', ')}`
            : '';
      row.innerHTML = `
        <input type="checkbox" ${checked ? 'checked' : ''} ${included || !ok ? 'disabled' : ''} />
        <span class="o-name">${option.name}${noteText ? `<span class="o-note">${noteText}</span>` : ''}</span>
        <span class="o-price">${included ? 'De série' : `+ ${formatPrice(option.price)}`}</span>`;
      const input = row.querySelector('input')!;
      input.addEventListener('change', () => {
        const others = this.config.options.filter((id) => id !== option.id);
        this.set({ options: input.checked ? [...others, option.id] : others });
      });
      list.append(row);
    }
    wrap.append(list);
    return wrap;
  }

  private summaryStep() {
    const wrap = el('div', 'group');
    const lines = priceLines(this.catalog, this.config);
    const total = totalPrice(this.catalog, this.config);
    const { months, deposit, rate } = this.catalog.financing;
    wrap.innerHTML = `
      <p class="group-title">Votre Aurore <span>${lines.length} lignes</span></p>
      <ul class="summary">
        ${lines
          .map(
            (l) => `<li><span class="s-label">${l.label}</span><span class="s-detail">${l.detail}</span>
            <span class="s-price ${l.included ? 's-included' : ''}">${l.included ? 'De série' : formatPrice(l.price)}</span></li>`
          )
          .join('')}
        <li><span class="s-label">Total TTC</span><span class="s-detail"><strong>${formatPrice(total)}</strong></span><span class="s-price">${formatPrice(monthly(this.catalog, total))}/mois*</span></li>
      </ul>
      <div class="summary-actions">
        <button class="btn-ghost" data-share>Copier le lien de cette configuration</button>
      </div>
      <p class="fineprint">* Location avec option d'achat sur ${months} mois, apport de ${formatPrice(deposit)}, taux annuel ${String(rate * 100).replace('.', ',')} %. Calcul indicatif, marque et tarifs fictifs.</p>`;
    wrap.querySelector('[data-share]')!.addEventListener('click', () => this.share());
    return wrap;
  }

  shareUrl() {
    const url = new URL(location.href);
    url.hash = '';
    url.searchParams.set('c', encodeConfig(this.config));
    return url.toString();
  }

  private async share() {
    const url = this.shareUrl();
    try {
      await navigator.clipboard.writeText(url);
      toast('Lien copié. Il rouvre cette configuration exacte.');
    } catch {
      prompt('Copiez ce lien :', url);
    }
  }

  private setupBooking() {
    const dialog = $<HTMLDialogElement>('#booking');
    const form = $<HTMLFormElement>('#booking-form');
    $('#booking-cancel').addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      dialog.close();
      form.reset();
      toast("Demande d'essai simulée : rien n'a été envoyé, c'est une démonstration.");
    });
  }

  private openBooking() {
    const trim = find(this.catalog.trims, this.config.trim);
    const paint = find(this.catalog.paints, this.config.paint);
    $('#booking-config').textContent = `Aurore ${trim.name}, ${paint.name}, ${formatPrice(totalPrice(this.catalog, this.config))}`;
    $<HTMLDialogElement>('#booking').showModal();
  }

  private trimNames(ids: string[]) {
    return ids.map((id) => find(this.catalog.trims, id).name).join(' et ');
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function toast(message: string) {
  const host = $('#toasts');
  const node = el('div', 'toast');
  node.textContent = message;
  host.append(node);
  while (host.children.length > 3) host.firstElementChild!.remove();
  setTimeout(() => {
    node.classList.add('out');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  }, 3800);
}
