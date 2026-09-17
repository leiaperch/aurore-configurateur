// Thème clair ou sombre : préférence système au premier passage, choix mémorisé ensuite.
// Le thème pilote la page (variables CSS) et le studio 3D (fond, sol, ombre).

export type Theme = 'light' | 'dark';

const KEY = 'aurore-theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

const stored = (): Theme | null => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
};

export class ThemeSwitch {
  theme: Theme;

  constructor(private onChange: (theme: Theme) => void) {
    this.theme = stored() ?? (media.matches ? 'dark' : 'light');
    this.apply(false);

    // tant que l'utilisateur n'a pas choisi, on suit le réglage du système
    media.addEventListener('change', (e) => {
      if (stored()) return;
      this.theme = e.matches ? 'dark' : 'light';
      this.apply();
    });

    document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]').forEach((b) =>
      b.addEventListener('click', () => {
        this.theme = this.theme === 'dark' ? 'light' : 'dark';
        try {
          localStorage.setItem(KEY, this.theme);
        } catch {
          /* navigation privée : le choix vaut pour la session */
        }
        this.apply();
      })
    );
  }

  private apply(notify = true) {
    const dark = this.theme === 'dark';
    document.documentElement.dataset.theme = this.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#101113' : '#f2f1ee');
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      b.setAttribute('aria-pressed', String(dark));
      b.setAttribute('aria-label', dark ? 'Passer en thème clair' : 'Passer en thème sombre');
      const label = b.querySelector('.theme-label');
      if (label) label.textContent = dark ? 'Clair' : 'Sombre';
    });
    if (notify) this.onChange(this.theme);
  }
}
