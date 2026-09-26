import * as THREE from 'three';
import { Width, Height } from '../game/tetrisField.js';
import { TextPlane } from './textPlane.js';

const BASE = import.meta.env.BASE_URL + 'assets/';
const BLOCK_TYPES = 11; // block1.png .. block11.png map to field values 1..11
const BOARD_SPAN = 18; // board (10) + gap + info panel
const PLAYER_GAP = 3;
const TOP = Height / 2 + 1; // world y of the board's top edge
const CUBE = 0.92;

/**
 * Three.js view of a GameScreen. Every frame the block instances are rebuilt
 * from the game state, so rendering holds no game logic of its own.
 */
export class Renderer {
  constructor(container, playerCount) {
    this.playerCount = playerCount;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
    this.baseDistance = 50;
    this.shake = 0;
    this.time = 0;

    this.addLights();
    this.loader = new THREE.TextureLoader();
    this.addBackground();
    this.createBlockMeshes();
    this.boards = [];
    for (let i = 0; i < playerCount; i++) this.boards.push(this.createBoard(i));

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  get totalWidth() {
    return this.playerCount * BOARD_SPAN + (this.playerCount - 1) * PLAYER_GAP;
  }

  boardOriginX(i) {
    return -this.totalWidth / 2 + i * (BOARD_SPAN + PLAYER_GAP);
  }

  addLights() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-15, 25, 30);
    this.scene.add(key);
  }

  addBackground() {
    const tex = this.loader.load(BASE + 'background/mountain-1920x1080.jpg');
    tex.colorSpace = THREE.SRGBColorSpace;
    // The original drew the background at 50% alpha over black.
    const material = new THREE.MeshBasicMaterial({ map: tex, color: 0x808080, depthWrite: false });
    this.background = new THREE.Mesh(new THREE.PlaneGeometry(16, 9), material);
    this.background.position.z = -30;
    this.background.renderOrder = -10;
    this.scene.add(this.background);
  }

  createBlockMeshes() {
    const geometry = new THREE.BoxGeometry(CUBE, CUBE, CUBE);
    const capacity = this.playerCount * (Width * Height + 64);
    this.solid = [];
    this.ghost = [];
    for (let t = 1; t <= BLOCK_TYPES; t++) {
      const map = this.loader.load(`${BASE}blocks/block${t}.png`);
      map.colorSpace = THREE.SRGBColorSpace;
      map.magFilter = THREE.NearestFilter;

      const solidMat = new THREE.MeshStandardMaterial({ map, roughness: 0.45, metalness: 0.05 });
      const solid = new THREE.InstancedMesh(geometry, solidMat, capacity);
      solid.count = 0;
      solid.frustumCulled = false;
      this.scene.add(solid);
      this.solid.push(solid);

      const ghostMat = new THREE.MeshBasicMaterial({ map, transparent: true, opacity: 0.2, depthWrite: false });
      const ghost = new THREE.InstancedMesh(geometry, ghostMat, capacity);
      ghost.count = 0;
      ghost.frustumCulled = false;
      ghost.renderOrder = 5;
      this.scene.add(ghost);
      this.ghost.push(ghost);
    }
    this.tmp = new THREE.Object3D();
  }

  createBoard(i) {
    const ox = this.boardOriginX(i);
    const group = new THREE.Group();
    this.scene.add(group);

    // Field background (white at 10%), pushed behind the cubes.
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(Width, Height),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, depthWrite: false }),
    );
    back.position.set(ox + Width / 2, TOP - Height / 2, -CUBE / 2 - 0.01);
    group.add(back);

    // Frame around the well.
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.3, metalness: 0.6 });
    const t = 0.3;
    const addBar = (w, h, x, y) => {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 1.1), frameMat);
      bar.position.set(x, y, 0);
      group.add(bar);
    };
    addBar(t, Height + t * 2, ox - t / 2, TOP - Height / 2);
    addBar(t, Height + t * 2, ox + Width + t / 2, TOP - Height / 2);
    addBar(Width, t, ox + Width / 2, TOP - Height - t / 2);

    const infoX = ox + Width + 1;
    const text = (y, color, opts = {}) => {
      const plane = new TextPlane({ width: 7, height: 0.8, color, ...opts });
      plane.mesh.position.set(infoX, TOP - y, 0.6);
      group.add(plane.mesh);
      return plane;
    };

    const banner = new TextPlane({ width: Width, height: 1.6, align: 'center', fontScale: 0.55 });
    banner.mesh.position.set(ox + Width / 2, TOP - 6, 1.2);
    const bannerBack = new THREE.Mesh(
      new THREE.PlaneGeometry(Width, 2.2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    bannerBack.position.set(ox + Width / 2, TOP - 6.8, 1.1);
    bannerBack.renderOrder = 9;
    group.add(bannerBack, banner.mesh);

    const texts = {
      score: text(0, '#ffffff'),
      lines: text(0.9, '#ffffff'),
      level: text(1.8, '#ffffff'),
      hold: text(3.4, '#ffff00'),
      next: text(9.4, '#9acd32'),
      player: text(Height - 0.8, '#aaaaaa', { fontScale: 0.45 }),
      banner,
    };
    texts.hold.set('HOLD');
    texts.next.set('NEXT');
    texts.player.set(`P${i + 1}`);

    return { ox, infoX, group, texts, bannerBack };
  }

  refreshText() {
    for (const b of this.boards) for (const t of Object.values(b.texts)) t.refresh();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;

    // Fit the whole play area (all boards, info panels and power rows).
    const fitW = this.totalWidth + 2;
    const fitH = Height + 5;
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.baseDistance = Math.max(fitH / 2 / tan, fitW / 2 / (tan * this.camera.aspect));
    this.camera.updateProjectionMatrix();

    // Cover the view with the background plane (keeping its 16:9 aspect).
    const dist = this.baseDistance + Math.abs(this.background.position.z);
    const viewH = 2 * dist * tan * 1.15;
    const viewW = viewH * this.camera.aspect;
    const scale = Math.max(viewW / 16, viewH / 9);
    this.background.scale.set(scale, scale, 1);
  }

  addShake(amount) {
    this.shake = Math.max(this.shake, amount);
  }

  draw(game, dtMs) {
    this.time += dtMs / 1000;
    for (const m of this.solid) m.count = 0;
    for (const m of this.ghost) m.count = 0;

    game.players.forEach((field, i) => this.drawPlayer(game, field, this.boards[i]));

    for (const m of [...this.solid, ...this.ghost]) m.instanceMatrix.needsUpdate = true;
    this.updateCamera(dtMs);
    this.renderer.render(this.scene, this.camera);
  }

  cellPos(ox, x, y) {
    return [ox + x + 0.5, TOP - y - 0.5];
  }

  pushBlock(meshes, value, wx, wy, z = 0, scale = 1) {
    const mesh = meshes[value - 1];
    if (!mesh) return;
    const t = this.tmp;
    t.position.set(wx, wy, z);
    t.rotation.set(0, 0, 0);
    t.scale.setScalar(scale);
    t.updateMatrix();
    mesh.setMatrixAt(mesh.count++, t.matrix);
  }

  drawPiece(piece, ox, oy, { meshes = this.solid, info = false, shadowY = null, scale = 1 } = {}) {
    if (!piece) return;
    const shape = piece.shape;
    for (let y = 0; y < shape.length; y++) {
      let yToDraw = info ? 0 : piece.posY;
      if (shadowY != null) yToDraw = info ? 0 : shadowY;
      yToDraw += y;
      if (yToDraw < 0) continue;
      for (let x = 0; x < shape[y].length; x++) {
        const v = shape[y][x];
        if (v === 0) continue;
        const cx = x + (info ? 0 : piece.posX);
        const [wx, wy] = this.cellPos(ox, cx * scale, oy + yToDraw * scale);
        this.pushBlock(meshes, v, wx, wy, 0, scale);
      }
    }
  }

  drawPlayer(game, field, board) {
    const { ox, infoX, texts } = board;

    if (field.isGameOver) {
      // Rainbow fill, like the original game-over screen.
      for (let y = 0; y < Height; y++) {
        for (let x = 0; x < Width; x++) {
          const [wx, wy] = this.cellPos(ox, x, y);
          this.pushBlock(this.solid, (y % 7) + 1, wx, wy);
        }
      }
    } else {
      for (let y = 0; y < Height; y++) {
        for (let x = 0; x < Width; x++) {
          const v = field.field[y][x];
          if (v === 0) continue;
          const [wx, wy] = this.cellPos(ox, x, y);
          // Power blocks bob gently so they stand out.
          const z = v >= 8 ? Math.sin(this.time * 4 + x + y) * 0.12 : 0;
          this.pushBlock(this.solid, v, wx, wy, z);
        }
      }
      if (field.shadowY > 0) {
        this.drawPiece(field.currentPiece, ox, 0, { meshes: this.ghost, shadowY: field.shadowY });
      }
      this.drawPiece(field.currentPiece, ox, 0);
    }

    // Collected powers under the well.
    field.powers.forEach((power, idx) => {
      const [wx, wy] = this.cellPos(ox, idx + 1, Height + 1);
      this.pushBlock(this.solid, power, wx, wy, 0, idx === 0 ? 1 : 0.8);
    });

    texts.score.set(`SCORE ${field.score}`);
    texts.lines.set(`LINES ${field.lines}`);
    texts.level.set(`LEVEL ${field.level + 1}`);

    const infoOx = infoX - ox; // piece offset relative to board origin
    this.drawPiece(field.heldPiece, ox + infoOx, 4.6, { info: true, scale: 0.8 });
    this.drawPiece(field.nextPiece, ox + infoOx, 10.6, { info: true, scale: 0.8 });

    let banner = '';
    if (game.pause) banner = 'PAUSE';
    else if (field.isWinner) banner = 'WINNER';
    texts.banner.set(banner);
    texts.banner.mesh.visible = board.bannerBack.visible = banner !== '';
  }

  updateCamera(dtMs) {
    const sway = 0.035;
    const angleX = Math.sin(this.time * 0.25) * sway;
    const angleY = Math.sin(this.time * 0.17) * sway * 0.6;
    const d = this.baseDistance;
    this.camera.position.set(Math.sin(angleX) * d, Math.sin(angleY) * d, Math.cos(angleX) * d);

    if (this.shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.shake = Math.max(0, this.shake - dtMs * 0.004);
    }
    this.camera.lookAt(0, 0, 0);
  }
}
