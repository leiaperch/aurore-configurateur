import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import gsap from 'gsap';
import { find, hasOption, type Catalog, type Config } from './catalog';
import type { Stage } from './stage';

// Voiture : chargement, matériaux pilotés par le catalogue, pièces mobiles.
// Chaque réglage du catalogue agit sur un matériau partagé (une teinte = un matériau pour toute la
// carrosserie), donc changer de couleur ne coûte ni chargement ni recompilation de shader.

export type Part = 'doors' | 'hood' | 'hatch';

// hinge : charnière déplacée (repère local de la pièce) quand le pivot d'origine ne convient pas
const PART_NODES: Record<Part, { name: string; axis: 'x' | 'y' | 'z'; angle: number; hinge?: [number, number, number] }[]> = {
  // repère du modèle : x latéral, y longueur (avant en -y), z vertical ; portes en élytre
  doors: [
    { name: 'BodyDoorLColor1', axis: 'x', angle: 1.05 },
    { name: 'BodyDoorRColor1', axis: 'x', angle: 1.05 },
  ],
  // capot articulé côté pare-brise (le pivot d'origine est à l'avant)
  hood: [{ name: 'BodyHood', axis: 'x', angle: -0.62, hinge: [0, 1.2, 0.66] }],
  hatch: [{ name: 'BodyRearPanelsColor1', axis: 'x', angle: -0.62 }],
};

const ACCENTS = {
  body: null,
  'gloss-black': { color: '#0c0d0f', metalness: 0.2, roughness: 0.12, clearcoat: 1, iridescence: 0 },
  graphite: { color: '#2e3134', metalness: 0.9, roughness: 0.22, clearcoat: 0.6, iridescence: 0.35 },
} as const;

export class Car {
  readonly root = new THREE.Group();
  readonly anchors: Record<string, THREE.Object3D> = {};
  readonly size = new THREE.Vector3();

  private paint!: THREE.MeshPhysicalMaterial;
  private accent!: THREE.MeshPhysicalMaterial;
  private rimFace!: THREE.MeshStandardMaterial;
  private rimBase!: THREE.MeshStandardMaterial;
  private caliper!: THREE.MeshStandardMaterial;
  private upholstery!: THREE.MeshStandardMaterial;
  private roof!: THREE.Mesh;
  private roofPaint!: THREE.Material;
  private roofGlass!: THREE.MeshPhysicalMaterial;
  private lamps: { mat: THREE.MeshStandardMaterial; color: THREE.Color }[] = [];
  private parts = new Map<Part, { node: THREE.Object3D; axis: 'x' | 'y' | 'z'; angle: number; base: number; t: number; basePos: THREE.Vector3; hinge?: THREE.Vector3 }[]>();
  private state: Record<Part, boolean> = { doors: false, hood: false, hatch: false };
  private lightsOn = false;
  private first = true;

  constructor(private stage: Stage) {}

  async load(url: string, onProgress: (p: number) => void) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url, (e) => e.total && onProgress(e.loaded / e.total));
    const model = gltf.scene;

    // posée au sol, centrée
    const box = new THREE.Box3().setFromObject(model);
    box.getSize(this.size);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    this.root.add(model);
    this.root.updateMatrixWorld(true);

    const brandMap = makeBrandTexture();
    const byName = new Map<string, THREE.MeshStandardMaterial>();
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      byName.set(mat.name, mat);
      // logo d'origine du modèle d'exemple remplacé par la marque fictive
      for (const slot of ['map', 'emissiveMap'] as const) {
        const tex = mat[slot];
        const img = tex?.image as { width?: number; height?: number } | undefined;
        if (img && img.width === 512 && img.height === 128) mat[slot] = brandMap;
      }
      if (mat.name === 'Dashboard') mat.emissiveMap = makeDashTexture();
    });

    // verre : réflexions de l'environnement sans passe de transmission (une passe de rendu en moins)
    const glass = new THREE.MeshPhysicalMaterial({
      name: 'Glass',
      color: 0x0a0c0f,
      metalness: 0,
      roughness: 0.02,
      transparent: true,
      opacity: 0.38,
      envMapIntensity: 1.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.paint = (byName.get('Paint 1 Carmine') as THREE.MeshPhysicalMaterial).clone();
    this.paint.name = 'Paint';
    this.accent = (byName.get('Paint 2 Carmine') as THREE.MeshPhysicalMaterial).clone();
    this.accent.name = 'Accent';
    this.upholstery = (byName.get('Interior 3 Carmine')!.clone());
    this.rimFace = (byName.get('Rim2')!.clone());
    this.rimBase = (byName.get('Rim1')!.clone());
    this.caliper = (byName.get('Brake')!.clone());
    this.roofGlass = new THREE.MeshPhysicalMaterial({
      color: 0x050608,
      metalness: 0.1,
      roughness: 0.04,
      clearcoat: 1,
      transparent: true,
      opacity: 0.82,
      envMapIntensity: 1.4,
    });

    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const name = (mesh.material as THREE.Material).name;
      if (name === 'Glass') mesh.material = glass;
      else if (name.startsWith('Paint 1')) mesh.material = this.paint;
      else if (name.startsWith('Paint 2')) mesh.material = this.accent;
      else if (name.startsWith('Interior 3')) mesh.material = this.upholstery;
      else if (name === 'Rim2') mesh.material = this.rimFace;
      else if (name === 'Rim1') mesh.material = this.rimBase;
      else if (name === 'Brake') mesh.material = this.caliper;
      // les variantes glTF d'origine ne servent plus : le catalogue pilote les matériaux
      delete mesh.userData.variantMaterials;
      if (mesh.name === 'BodyRoofPanel' || mesh.parent?.name === 'BodyRoofPanel') this.roof = mesh;
    });
    this.roofPaint = this.roof.material as THREE.Material;

    for (const name of ['Headlight', 'Signallight', 'Brakelight']) {
      const mat = byName.get(name);
      if (!mat) continue;
      this.lamps.push({ mat, color: mat.emissive.clone() });
      mat.emissiveIntensity = 0.15;
      mat.toneMapped = false;
    }

    for (const [part, defs] of Object.entries(PART_NODES) as [Part, (typeof PART_NODES)[Part]][]) {
      this.parts.set(
        part,
        defs.flatMap((d) => {
          const node = model.getObjectByName(d.name);
          return node
            ? [{ node, axis: d.axis, angle: d.angle, base: node.rotation[d.axis], t: 0, basePos: node.position.clone(), hinge: d.hinge && new THREE.Vector3(...d.hinge) }]
            : [];
        })
      );
    }

    // points d'ancrage pour la caméra et les points d'intérêt, en coordonnées monde
    const anchor = (key: string, name: string) => {
      const node = model.getObjectByName(name);
      if (node) this.anchors[key] = node;
    };
    anchor('wheel', 'WheelFrontL');
    anchor('seat', 'InteriorSeatsColor1');
    anchor('dash', 'InteriorSteeringDash');
    anchor('hood', 'BodyHood');
    anchor('doorL', 'BodyDoorLColor1');
    anchor('lights', 'BodyHeadlights');
    anchor('rear', 'BodyTaillights');

    this.stage.scene.add(this.root);
    this.stage.addContactShadow(this.root, new THREE.Vector2(this.size.x * 2.1, this.size.z * 1.45));
    this.stage.invalidate();
  }

  apply(catalog: Catalog, config: Config) {
    const paint = find(catalog.paints, config.paint);
    const trim = find(catalog.trims, config.trim);
    const wheel = find(catalog.wheels, config.wheels);
    const caliper = find(catalog.calipers, config.calipers);
    const interior = find(catalog.interiors, config.interior);
    const accent = ACCENTS[trim.accent] ?? { color: paint.hex, ...paint };

    const d = this.first ? 0 : 0.9;
    this.first = false;
    const release = this.stage.hold();
    const tl = gsap.timeline({ defaults: { duration: d, ease: 'power2.inOut' }, onComplete: release });

    tweenColor(tl, this.paint.color, paint.hex);
    tl.to(this.paint, { metalness: paint.metalness, roughness: paint.roughness, clearcoat: live(paint.clearcoat), iridescence: live(paint.iridescence) }, 0);
    tl.to(this.paint.normalScale, { x: paint.flakes, y: paint.flakes }, 0);

    tweenColor(tl, this.accent.color, accent.color);
    tl.to(this.accent, { metalness: accent.metalness, roughness: accent.roughness, clearcoat: live(accent.clearcoat), iridescence: live(accent.iridescence) }, 0);

    tweenColor(tl, this.rimFace.color, wheel.hex);
    tl.to(this.rimFace, { metalness: wheel.metalness, roughness: wheel.roughness }, 0);
    tweenColor(tl, this.rimBase.color, wheel.hex);
    tl.to(this.rimBase, { metalness: wheel.metalness, roughness: wheel.roughness + 0.1 }, 0);
    tweenColor(tl, this.caliper.color, caliper.hex!);
    tweenColor(tl, this.upholstery.color, interior.hex!);

    const glassRoof = hasOption(catalog, config, 'toit');
    if (glassRoof !== (this.roof.material === this.roofGlass)) {
      tl.call(() => {
        this.roof.material = glassRoof ? this.roofGlass : this.roofPaint;
      }, undefined, d * 0.5);
    }
    if (d === 0) tl.progress(1);
  }

  isOpen(part: Part) {
    return this.state[part];
  }

  toggle(part: Part, open = !this.state[part]) {
    this.state[part] = open;
    const release = this.stage.hold();
    const tl = gsap.timeline({ onComplete: release });
    for (const p of this.parts.get(part) ?? []) {
      tl.to(p, { t: open ? 1 : 0, duration: open ? 1.3 : 1.05, ease: open ? 'power3.inOut' : 'power2.inOut', onUpdate: () => setHinge(p) }, 0);
    }
    this.stage.refreshShadow();
    return open;
  }

  toggleLights(on = !this.lightsOn) {
    this.lightsOn = on;
    const release = this.stage.hold();
    const tl = gsap.timeline({ onComplete: release });
    this.lamps.forEach(({ mat }, i) => {
      tl.to(mat, { emissiveIntensity: on ? (i === 0 ? 5 : 3) : 0.15, duration: 0.5, ease: on ? 'steps(3)' : 'power1.out' }, i * 0.08);
    });
    return on;
  }

  worldPosition(key: string, offset = new THREE.Vector3()) {
    const node = this.anchors[key];
    if (!node) return offset.clone();
    const box = new THREE.Box3().setFromObject(node);
    return box.getCenter(new THREE.Vector3()).add(offset);
  }
}

// three.js ne compile la couche vernis ou iridescence que si sa valeur est non nulle : passer par zéro pendant
// une transition recompilerait le shader et ferait sauter une image. On garde une valeur infime à la place.
const live = (value: number) => Math.max(value, 1e-4);

function tweenColor(tl: gsap.core.Timeline, color: THREE.Color, hex: string) {
  const target = new THREE.Color(hex);
  tl.to(color, { r: target.r, g: target.g, b: target.b }, 0);
}

// Monogramme et nom de la marque, au format de la texture d'origine (512 × 128) : plaque, volant, jantes, étriers
// Rotation autour d'une charnière : la position compense pour que le point de charnière reste immobile
const _p = new THREE.Vector3();
function setHinge(p: { node: THREE.Object3D; axis: 'x' | 'y' | 'z'; angle: number; base: number; t: number; basePos: THREE.Vector3; hinge?: THREE.Vector3 }) {
  p.node.rotation[p.axis] = p.base + p.angle * p.t;
  if (!p.hinge) return;
  _p.copy(p.hinge).applyEuler(p.node.rotation);
  p.node.position.copy(p.basePos).add(p.hinge).sub(_p);
}

function makeBrandTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 512, 128);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '600 58px "Inter Tight", "Helvetica Neue", Arial, sans-serif';
  g.letterSpacing = '22px';
  g.fillText('NORVANE', 268, 58);
  g.font = '500 15px "Inter Tight", Arial, sans-serif';
  g.letterSpacing = '9px';
  g.fillText('AURORE · ÉLECTRIQUE', 262, 104);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  return tex;
}

// Combiné d'instrumentation d'une voiture électrique (autonomie, énergie, vitesse)
function makeDashTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 1024, 256);
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(80, 236);
  g.lineTo(190, 20);
  g.lineTo(834, 20);
  g.lineTo(944, 236);
  g.closePath();
  g.stroke();
  g.textAlign = 'center';
  g.font = '200 120px "Inter Tight", Arial, sans-serif';
  g.fillText('0', 512, 150);
  g.font = '500 22px "Inter Tight", Arial, sans-serif';
  g.fillText('km/h', 512, 200);
  g.textAlign = 'left';
  g.fillText('AUTONOMIE', 250, 80);
  g.font = '300 56px "Inter Tight", Arial, sans-serif';
  g.fillText('520 km', 250, 140);
  for (let i = 0; i < 10; i++) g.fillRect(250 + i * 17, 170, 11, i < 8 ? 26 : 8);
  g.textAlign = 'right';
  g.font = '500 22px "Inter Tight", Arial, sans-serif';
  g.fillText('ÉNERGIE', 774, 80);
  g.font = '300 56px "Inter Tight", Arial, sans-serif';
  g.fillText('14,2', 774, 140);
  g.font = '500 20px "Inter Tight", Arial, sans-serif';
  g.fillText('kWh/100 km', 774, 190);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  return tex;
}
