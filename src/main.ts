import './styles.css';
import { decodeConfig, encodeConfig, loadCatalog, normalize } from './catalog';
import { Stage } from './stage';
import { Car, type Part } from './car';
import { Views, type ViewId } from './views';
import { Ui, toast, type Step } from './ui';
import { ThemeSwitch } from './theme';

const STEP_VIEW: Partial<Record<Step, ViewId>> = {
  trim: 'trois-quarts',
  paint: 'trois-quarts',
  wheels: 'jantes',
  interior: 'interieur',
  options: 'arriere',
  summary: 'trois-quarts',
};

async function boot() {
  const loaderBar = document.querySelector<HTMLElement>('#loader-bar')!;
  const loaderText = document.querySelector<HTMLElement>('#loader-text')!;
  const progress = (p: number) => (loaderBar.style.transform = `scaleX(${p})`);

  const catalog = await loadCatalog();
  const { config, notices } = normalize(catalog, decodeConfig(catalog, new URLSearchParams(location.search).get('c')));

  const stage = new Stage(document.querySelector('#viewport')!);
  const car = new Car(stage);
  const themes = new ThemeSwitch((theme) => stage.buildStudio(theme === 'dark'));
  stage.buildStudio(themes.theme === 'dark');
  await car.load('models/aurore.glb', (p) => progress(p * 0.9));
  car.apply(catalog, config);


  const views = new Views(stage, car);
  views.go('trois-quarts', true);
  // les shaders sont compilés avant de retirer l'écran de chargement : aucune saccade au premier geste
  loaderText.textContent = 'Préparation des matériaux';
  await stage.renderer.compileAsync(stage.scene, stage.camera);
  progress(1);
  stage.invalidate();

  const setView = (id: ViewId) => {
    if (id === 'interieur' && !car.isOpen('doors')) setPart('doors', true);
    views.go(id);
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === id)));
  };
  const setPart = (part: Part, open?: boolean) => {
    const state = car.toggle(part, open);
    document.querySelector(`[data-part="${part}"]`)?.setAttribute('aria-pressed', String(state));
  };

  const ui = new Ui(catalog, config, {
    onChange: (next) => {
      car.apply(catalog, next);
      history.replaceState(null, '', `?c=${encodeConfig(next)}${location.hash}`);
    },
    onStep: (step) => {
      const view = STEP_VIEW[step];
      if (view && view !== views.current) setView(view);
      if (step !== 'interior' && views.current !== 'interieur' && car.isOpen('doors')) setPart('doors', false);
    },
  });

  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view as ViewId)));
  document.querySelectorAll<HTMLButtonElement>('[data-part]').forEach((b) => b.addEventListener('click', () => setPart(b.dataset.part as Part)));
  const lightsBtn = document.querySelector<HTMLButtonElement>('[data-lights]')!;
  lightsBtn.addEventListener('click', () => lightsBtn.setAttribute('aria-pressed', String(car.toggleLights())));

  const hint = document.querySelector('#hint')!;
  stage.controls.addEventListener('start', () => hint.classList.add('gone'));

  document.querySelector('#loader')!.classList.add('done');
  // allumage des feux juste après l'ouverture, comme à la présentation d'une voiture en showroom
  setTimeout(() => lightsBtn.setAttribute('aria-pressed', String(car.toggleLights(true))), 900);
  notices.forEach((n) => toast(n));

  // accès de débogage en développement uniquement
  if (import.meta.env.DEV) Object.assign(window, { __aurore: { stage, car, views, ui } });

  liveMetrics(stage);
  revealOnScroll();
}

// Mesures lues sur le moteur de rendu, affichées seulement quand la section est visible
function liveMetrics(stage: Stage) {
  const section = document.querySelector('#metrics')!;
  const out = (key: string) => section.querySelector<HTMLElement>(`[data-live="${key}"]`)!;
  const nf = new Intl.NumberFormat('fr-FR');
  let timer = 0;
  const update = () => {
    const { render } = stage.renderer.info;
    const { frames, idle } = stage.stats;
    out('calls').textContent = nf.format(render.calls);
    out('triangles').textContent = nf.format(render.triangles);
    out('frames').textContent = nf.format(frames);
    out('idle').textContent = `${Math.round((idle / Math.max(1, frames + idle)) * 100)} %`;
    out('dpr').textContent = `${stage.renderer.getPixelRatio().toFixed(2).replace('.', ',')}×`;
  };
  new IntersectionObserver(([e]) => {
    clearInterval(timer);
    if (e.isIntersecting) {
      update();
      timer = window.setInterval(update, 500);
    }
  }).observe(section);
}

function revealOnScroll() {
  const items = document.querySelectorAll<HTMLElement>('.case-hero, .case-block, .case-contact');
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add('in'), io.unobserve(e.target))),
    { rootMargin: '0px 0px -12% 0px' }
  );
  items.forEach((el) => {
    el.classList.add('reveal');
    io.observe(el);
  });
}

boot().catch((err) => {
  console.error(err);
  const text = document.querySelector('#loader-text');
  if (text) text.textContent = "Le configurateur n'a pas pu démarrer sur ce navigateur (WebGL 2 requis).";
});
