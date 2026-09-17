import * as THREE from 'three';
import type { Car } from './car';
import type { Stage } from './stage';
import type { ViewId } from './views';

// Repères techniques accrochés à la voiture : un point sur la carrosserie, un trait, une valeur.
// Ils sont repositionnés à chaque image calculée (donc jamais au repos) et masqués quand le point passe
// derrière la voiture ou hors du cadre.

export interface CalloutDef {
  id: string;
  anchor: string;
  offset: [number, number, number];
  views: ViewId[];
  side: 1 | -1; // étiquette à droite ou à gauche du point
}

export class Callouts {
  private items: { def: CalloutDef; el: HTMLElement; value: HTMLElement; world: THREE.Vector3; shown: boolean; occluded: boolean }[] = [];
  private frame = 0;
  private view: ViewId = 'trois-quarts';
  private v = new THREE.Vector3();
  private ray = new THREE.Raycaster();
  private enabled = true;

  constructor(
    private host: HTMLElement,
    private stage: Stage,
    private car: Car,
    defs: CalloutDef[]
  ) {
    for (const def of defs) {
      const el = document.createElement('div');
      el.className = `callout ${def.side < 0 ? 'left' : ''}`;
      el.innerHTML = `<i class="dot"></i><i class="stem"></i><span class="label"><span class="k"></span><span class="val"></span></span>`;
      host.append(el);
      this.items.push({ def, el, value: el.querySelector('.val')!, world: new THREE.Vector3(), shown: false, occluded: false });
    }
    this.measure();
    stage.each(() => this.update());
  }

  // positions monde recalculées quand une pièce bouge ou au chargement
  measure() {
    for (const item of this.items) item.world.copy(this.car.worldPosition(item.def.anchor, new THREE.Vector3(...item.def.offset)));
  }

  set(id: string, key: string, value: string) {
    const item = this.items.find((i) => i.def.id === id);
    if (!item) return;
    item.el.querySelector('.k')!.textContent = key;
    item.value.textContent = value;
  }

  setView(view: ViewId) {
    this.view = view;
    this.stage.invalidate();
  }

  toggle(on: boolean) {
    this.enabled = on;
    this.host.classList.toggle('off', !on);
  }

  private update() {
    const { camera, renderer } = this.stage;
    const rect = renderer.domElement.getBoundingClientRect();
    // le test d'occultation (lancer de rayon sur la voiture) coûte cher : une image sur six suffit
    const checkOcclusion = this.frame++ % 6 === 0 || this.stage.settling;
    for (const item of this.items) {
      let visible = this.enabled && item.def.views.includes(this.view);
      if (visible) {
        this.v.copy(item.world).project(camera);
        visible = this.v.z < 1 && Math.abs(this.v.x) < 0.92 && Math.abs(this.v.y) < 0.88;
        if (visible && checkOcclusion) {
          // le point doit être vu directement, pas à travers la carrosserie
          const dist = camera.position.distanceTo(item.world);
          this.ray.set(camera.position, item.world.clone().sub(camera.position).normalize());
          this.ray.far = dist - 0.08;
          item.occluded = this.ray.intersectObject(this.car.root, true).length > 0;
        }
        visible &&= !item.occluded;
        const x = (this.v.x * 0.5 + 0.5) * rect.width;
        const y = (-this.v.y * 0.5 + 0.5) * rect.height;
        item.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      }
      if (visible !== item.shown) {
        item.shown = visible;
        item.el.classList.toggle('on', visible);
      }
    }
  }
}
