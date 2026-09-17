import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Scène de présentation : studio de nuit généré en code, sol miroir, ombre de contact précalculée, rendu à la demande.
// Rien n'est dessiné tant que rien ne bouge : un configurateur passe l'essentiel de son temps à attendre
// un clic, le GPU n'a pas à tourner pendant ce temps.

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.05, 60);
  readonly controls: OrbitControls;
  readonly stats = { frames: 0, idle: 0, lastFrameMs: 0 };

  private dirty = 2;
  private active = true;
  private animating = 0;
  private shadow?: ContactShadow;
  private shadowDirty = false;
  private onFrame: ((dt: number) => void)[] = [];
  private timer = new THREE.Timer();
  private slowFrames = 0;
  private maxDpr = Math.min(window.devicePixelRatio, 2);

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.maxDpr);
    // PBR Neutral (Khronos) : conçu pour le e-commerce, la teinte affichée reste fidèle à la couleur du nuancier
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.setClearColor(0x000000, 0);
    host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 4.2;
    this.controls.maxDistance = 14;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04;
    this.controls.rotateSpeed = 0.6;
    this.controls.addEventListener('change', () => this.invalidate());

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();

    // on arrête tout rendu quand le configurateur sort de l'écran
    new IntersectionObserver(([entry]) => {
      this.active = entry.isIntersecting;
      if (this.active) this.invalidate();
    }).observe(host);
    document.addEventListener('visibilitychange', () => this.invalidate());

    this.renderer.setAnimationLoop(() => this.tick());
  }

  // Studio construit en code puis converti en éclairage d'environnement (PMREM) : des bandes lumineuses
  // dessinent les reflets sur la carrosserie. Aucune image HDR à télécharger, un seul calcul au chargement.
  // Studio photo : un cyclorama clair et quelques sources larges, converti une fois en éclairage
  // d'environnement (PMREM). C'est l'éclairage d'un shooting automobile, sans image HDR à télécharger.
  buildStudio() {
    const room = new THREE.Scene();
    const shell = new THREE.Mesh(new THREE.BoxGeometry(34, 14, 34), new THREE.MeshBasicMaterial({ color: 0xbfc0c2, side: THREE.BackSide }));
    shell.position.y = 6;
    room.add(shell);
    const panel = (w: number, h: number, power: number, pos: [number, number, number], rot: [number, number, number], color = 0xffffff) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power), side: THREE.DoubleSide }));
      m.position.set(...pos);
      m.rotation.set(...rot);
      room.add(m);
    };
    // grande boîte à lumière au plafond, deux panneaux latéraux, un contre-jour derrière
    panel(9, 16, 5, [0, 6.6, 0], [Math.PI / 2, 0, 0]);
    for (const side of [-1, 1]) panel(12, 6, 2.2, [side * 8.5, 3, 0], [0, (side * Math.PI) / 2, 0]);
    panel(14, 5, 1.6, [0, 2.6, -11], [0, 0, 0]);
    // deux filés étroits pour marquer les arêtes de la carrosserie
    for (const x of [-2.6, 2.6]) panel(0.5, 14, 9, [x, 5.4, 0], [Math.PI / 2, 0, 0]);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(room, 0.03).texture;
    this.scene.environmentIntensity = 1;
    pmrem.dispose();
    room.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });

    // sol : gris clair, légèrement réfléchissant sous la voiture, qui se fond dans la page sur les bords
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(14, 96),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uColor: { value: new THREE.Color(0xe9e8e5) } },
        vertexShader: /* glsl */ `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; varying vec2 vP;
          void main(){
            float r = length(vP * vec2(1.0, 0.8));
            float a = mix(0.93, 0.995, smoothstep(1.0, 5.0, r)) * (1.0 - smoothstep(6.0, 13.5, r));
            gl_FragColor = vec4(uColor, a);
            #include <colorspace_fragment>
          }`,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.renderOrder = -2;
    this.scene.add(floor);
    this.invalidate();
  }

  addContactShadow(target: THREE.Object3D, size: THREE.Vector2) {
    this.shadow = new ContactShadow(this.renderer, target, size);
    this.scene.add(this.shadow.plane);
    this.shadowDirty = true;
    this.invalidate();
  }

  // à appeler quand la silhouette de la voiture change (portes, capot…)
  refreshShadow() {
    this.shadowDirty = true;
    this.invalidate();
  }

  invalidate(frames = 2) {
    this.dirty = Math.max(this.dirty, frames);
  }

  // garde le rendu actif pendant une animation (transition de caméra, ouverture de porte…)
  hold() {
    this.animating++;
    this.invalidate();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.animating--;
      this.invalidate();
    };
  }

  // vrai pendant la dernière image avant le repos : moment pour les calculs qu'on ne fait pas à chaque image
  get settling() {
    return this.animating === 0 && this.dirty <= 0;
  }

  each(fn: (dt: number) => void) {
    this.onFrame.push(fn);
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // voiture entière visible même en portrait : on recule le champ vertical sur écran étroit
    this.camera.fov = w / h < 1 ? 46 : 32;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private tick() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    if (!this.active || document.hidden) return;
    const moved = this.controls.update(dt);
    if (moved) this.invalidate();
    if (this.dirty <= 0 && this.animating === 0) {
      this.stats.idle++;
      return;
    }
    this.dirty--;
    const t0 = performance.now();
    for (const fn of this.onFrame) fn(dt);
    if (this.shadow && this.shadowDirty) {
      this.shadow.bake();
      this.shadowDirty = this.animating > 0; // pendant une ouverture de porte, l'ombre suit
    }
    this.renderer.render(this.scene, this.camera);
    this.stats.frames++;
    this.stats.lastFrameMs = performance.now() - t0;
    this.adaptQuality(dt);
  }

  // Résolution adaptative : sur un GPU intégré qui décroche, on baisse la densité de pixels par paliers.
  private adaptQuality(dt: number) {
    if (dt > 1 / 40) this.slowFrames++;
    else this.slowFrames = Math.max(0, this.slowFrames - 2);
    if (this.slowFrames > 45) {
      const next = Math.max(1, this.renderer.getPixelRatio() - 0.25);
      if (next < this.renderer.getPixelRatio()) {
        this.renderer.setPixelRatio(next);
        this.resize();
      }
      this.slowFrames = 0;
    }
  }
}

// Ombre de contact : la voiture est vue d'en dessous en profondeur, floutée deux fois, puis posée au sol.
// Un seul rendu à la demande, au lieu d'une ombre portée recalculée à chaque image.
class ContactShadow {
  readonly plane: THREE.Mesh;
  private rt: THREE.WebGLRenderTarget;
  private blurRt: THREE.WebGLRenderTarget;
  private cam: THREE.OrthographicCamera;
  private depthMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(
    private renderer: THREE.WebGLRenderer,
    private target: THREE.Object3D,
    size: THREE.Vector2,
    height = 1.1
  ) {
    const res = 512;
    const opts = { type: THREE.HalfFloatType };
    this.rt = new THREE.WebGLRenderTarget(res, res, opts);
    this.blurRt = new THREE.WebGLRenderTarget(res, res, opts);

    this.cam = new THREE.OrthographicCamera(-size.x / 2, size.x / 2, size.y / 2, -size.y / 2, 0, height);
    this.cam.rotation.x = Math.PI / 2; // regarde vers le haut depuis le sol

    this.depthMat = new THREE.ShaderMaterial({
      uniforms: { uHeight: { value: height } },
      vertexShader: /* glsl */ `
        varying float vH;
        void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vH = w.y; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uHeight; varying float vH;
        void main(){ float a = 1.0 - clamp(vH / uHeight, 0.0, 1.0); gl_FragColor = vec4(vec3(0.0), a * a * a); }`,
      side: THREE.DoubleSide,
    });

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tMap; uniform vec2 uDir; varying vec2 vUv;
        void main(){
          float w[5] = float[](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
          vec4 c = texture2D(tMap, vUv) * w[0];
          for (int i = 1; i < 5; i++) {
            c += texture2D(tMap, vUv + uDir * float(i)) * w[i];
            c += texture2D(tMap, vUv - uDir * float(i)) * w[i];
          }
          gl_FragColor = c;
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMat);
    this.quadScene.add(this.quad);

    const planeMat = new THREE.ShaderMaterial({
      uniforms: { tShadow: { value: this.rt.texture }, uOpacity: { value: 0.55 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tShadow; uniform float uOpacity; varying vec2 vUv;
        void main(){
          float a = texture2D(tShadow, vec2(vUv.x, 1.0 - vUv.y)).a;
          float edge = smoothstep(0.5, 0.36, length(vUv - 0.5));
          gl_FragColor = vec4(vec3(0.16, 0.16, 0.17), a * uOpacity * edge);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.y), planeMat);
    this.plane.rotation.x = -Math.PI / 2;
    this.plane.position.y = 0.002;
    this.plane.renderOrder = -1;
  }

  bake() {
    const { renderer } = this;
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearAlpha();
    const prevTone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;

    // rendu de la voiture seule, sans le reste de la scène
    const scene = new THREE.Scene();
    const parent = this.target.parent;
    scene.add(this.target);
    scene.overrideMaterial = this.depthMat;
    this.cam.position.set(0, 0, 0);
    this.cam.updateMatrixWorld();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, this.cam);
    parent?.add(this.target);

    // deux passes de flou séparables
    const texel = 1 / this.rt.width;
    for (const spread of [1.6, 0.8]) {
      this.blur(this.rt, this.blurRt, texel * spread, 0);
      this.blur(this.blurRt, this.rt, 0, texel * spread);
    }

    renderer.setRenderTarget(prevTarget);
    renderer.setClearAlpha(prevClear);
    renderer.toneMapping = prevTone;
  }

  private blur(from: THREE.WebGLRenderTarget, to: THREE.WebGLRenderTarget, x: number, y: number) {
    this.blurMat.uniforms.tMap.value = from.texture;
    this.blurMat.uniforms.uDir.value.set(x, y);
    this.renderer.setRenderTarget(to);
    this.renderer.clear();
    this.renderer.render(this.quadScene, this.quadCam);
  }
}
