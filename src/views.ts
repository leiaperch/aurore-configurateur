import * as THREE from 'three';
import gsap from 'gsap';
import type { Car } from './car';
import type { Stage } from './stage';

// Plans de caméra nommés. Les transitions passent par un arc autour de la voiture plutôt qu'en ligne droite,
// ce qui évite de traverser la carrosserie entre deux vues opposées.

export type ViewId = 'trois-quarts' | 'profil' | 'arriere' | 'jantes' | 'interieur';

interface Shot {
  position: THREE.Vector3;
  target: THREE.Vector3;
  interior?: boolean;
}

export class Views {
  current: ViewId = 'trois-quarts';
  private tween?: gsap.core.Tween;
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(
    private stage: Stage,
    private car: Car
  ) {}

  private shot(id: ViewId): Shot {
    const narrow = this.stage.camera.aspect < 1;
    const far = narrow ? 1.08 : 1;
    const len = this.car.size.z;
    switch (id) {
      case 'trois-quarts':
        return { position: new THREE.Vector3(5.5, 1.75, 6.7).multiplyScalar(far), target: new THREE.Vector3(0, 0.55, 0.1) };
      case 'profil':
        return { position: new THREE.Vector3(len * 2.05, 1.0, 0.15).multiplyScalar(far), target: new THREE.Vector3(0, 0.62, 0) };
      case 'arriere':
        return { position: new THREE.Vector3(-4.6, 1.9, -7.0).multiplyScalar(far), target: new THREE.Vector3(0, 0.66, -0.2) };
      case 'jantes': {
        const wheel = this.car.worldPosition('wheel');
        return { position: wheel.clone().add(new THREE.Vector3(2.35, 0.25, 1.1)), target: wheel.clone().add(new THREE.Vector3(0, 0.05, -0.15)) };
      }
      case 'interieur': {
        const seat = this.car.worldPosition('seat');
        const dash = this.car.worldPosition('dash');
        // place conducteur : côté gauche (+x), à hauteur des yeux
        const eye = new THREE.Vector3(seat.x + 0.36, seat.y + 0.36, seat.z - 0.22);
        return { position: eye, target: new THREE.Vector3(dash.x, dash.y + 0.12, dash.z), interior: true };
      }
    }
  }

  go(id: ViewId, instant = false) {
    this.current = id;
    const { camera, controls } = this.stage;
    const shot = this.shot(id);
    this.tween?.kill();

    // limites de l'orbite selon le plan : à l'intérieur on tourne la tête, dehors on tourne autour
    const applyLimits = () => {
      if (shot.interior) {
        // cible très proche de l'œil : l'orbite devient un regard
        const dir = shot.target.clone().sub(shot.position).normalize().multiplyScalar(0.02);
        controls.target.copy(shot.position).add(dir);
        camera.position.copy(shot.position);
        controls.minDistance = controls.maxDistance = 0.02;
        controls.minPolarAngle = 0.9;
        controls.maxPolarAngle = 2.1;
        controls.rotateSpeed = -0.35;
        controls.enableZoom = false;
      } else {
        controls.minDistance = id === 'jantes' ? 1.6 : 4.2;
        controls.maxDistance = 14;
        controls.minPolarAngle = 0.35;
        controls.maxPolarAngle = Math.PI / 2 - 0.04;
        controls.rotateSpeed = 0.6;
        controls.enableZoom = true;
      }
    };

    if (instant || this.reduced) {
      camera.position.copy(shot.position);
      controls.target.copy(shot.target);
      applyLimits();
      controls.update();
      this.stage.invalidate();
      return;
    }

    // interpolation en coordonnées sphériques autour de la voiture
    const fromTarget = controls.target.clone();
    const fromPos = camera.position.clone();
    const a = new THREE.Spherical().setFromVector3(fromPos.clone().sub(fromTarget));
    const b = new THREE.Spherical().setFromVector3(shot.position.clone().sub(shot.target));
    let dTheta = b.theta - a.theta;
    if (dTheta > Math.PI) dTheta -= Math.PI * 2;
    if (dTheta < -Math.PI) dTheta += Math.PI * 2;
    const leavingInterior = controls.minDistance < 0.1;
    const entering = !!shot.interior;

    // pendant la transition, les limites de l'orbite ne doivent pas brider la caméra
    controls.minDistance = 0;
    controls.maxDistance = Infinity;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
    controls.enabled = false;

    const inside = entering ? shot.position : fromPos;
    const doorway = new THREE.Vector3(inside.x + 2.4, inside.y + 0.1, inside.z + 0.2);

    const release = this.stage.hold();
    const p = { t: 0 };
    const s = new THREE.Spherical();
    this.tween = gsap.to(p, {
      t: 1,
      duration: entering || leavingInterior ? 1.9 : 1.5,
      ease: 'power3.inOut',
      onUpdate: () => {
        const t = p.t;
        if (entering || leavingInterior) {
          // entrée et sortie de l'habitacle : courbe qui passe par l'ouverture de la porte conducteur
          bezier(fromPos, doorway, shot.position, t, camera.position);
          controls.target.lerpVectors(fromTarget, shot.target, t);
        } else {
          controls.target.lerpVectors(fromTarget, shot.target, t);
          s.set(
            THREE.MathUtils.lerp(a.radius, b.radius, t) + Math.sin(t * Math.PI) * 0.6,
            THREE.MathUtils.lerp(a.phi, b.phi, t),
            a.theta + dTheta * t
          );
          camera.position.setFromSpherical(s).add(controls.target);
        }
        camera.lookAt(controls.target);
      },
      onComplete: () => {
        applyLimits();
        controls.enabled = true;
        controls.update();
        release();
      },
      onInterrupt: () => {
        controls.enabled = true;
        release();
      },
    });
  }
}

function bezier(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3) {
  const u = 1 - t;
  return out.set(
    u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    u * u * a.z + 2 * u * t * c.z + t * t * b.z
  );
}
