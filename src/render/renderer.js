import * as THREE from 'three';
import { Width, Height } from '../game/tetrisField.js';
import { TextPlane } from './textPlane.js';

const BASE = import.meta.env.BASE_URL + 'assets/';
const BLOCK_TYPES = 11; // block1.png .. block11.png map to field values 1..11
const MAX_BOARDS = 2;
const PLAYER_GAP = 3;
const CUBE = 0.92;
const FRAME = 0.3;

/*
 * Each board is a group whose origin is the top-left corner of the well, so
 * cell (x, y) sits at local (x + 0.5, -y - 0.5). Two layouts place the info:
 *   landscape: score, hold and next to the right of the well (desktop, versus)
 *   portrait:  a compact HUD above the well (phones held upright)
 * Bounds are the local extents used to centre and fit the camera.
 */
const LAYOUTS = {
  landscape: {
    bounds: { minX: -FRAME, maxX: 18, minY: -22.1, maxY: 0.4 },
    hold: { x: 11, y: -4.6, scale: 0.8 },
    next: { x: 11, y: -10.6, scale: 0.8 },
    powers: { x: 1, y: -21, step: 1, scale: 1, rest: 0.8 },
  },
  portrait: {
    bounds: { minX: -FRAME, maxX: Width + FRAME, minY: -Height - FRAME, maxY: 5.6 },
    hold: { x: 0.1, y: 3.0, scale: 0.6 },
    next: { x: 7.1, y: 3.0, scale: 0.6 },
    powers: { x: 3.55, y: 2.8, step: 0.62, scale: 0.6, rest: 0.5 },
  },
};

/**
 * Three.js view of a GameScreen. Every frame the block instances are rebuilt
 * from the game state, so rendering holds no game logic of its own.
 */
export class Renderer {
  /** @param boards how many boards to draw (see setBoards) */
  constructor(container, boards = 1) {
    this.container = container;
    this.layout = null;
    this.pxPerUnit = 20;
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
    this.setBoards(boards);
    new ResizeObserver(() => this.resize()).observe(container);
  }

  /** Replaces the boards, e.g. when switching between solo and online play. */
  setBoards(count) {
    for (const board of this.boards) this.disposeBoard(board);
    this.boards = [];
    for (let i = 0; i < Math.min(count, MAX_BOARDS); i++) this.boards.push(this.createBoard(i));
    this.layout = null;
    this.resize();
  }

  disposeBoard(board) {
    this.scene.remove(board.group);
    board.group.traverse((obj) => {
      obj.geometry?.dispose();
      obj.material?.map?.dispose();
      obj.material?.dispose();
    });
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
    const capacity = MAX_BOARDS * (Width * Height + 64);
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
    const group = new THREE.Group();
    this.scene.add(group);

    // Field background (white at 10%), pushed behind the cubes.
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(Width, Height),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, depthWrite: false }),
    );
    back.position.set(Width / 2, -Height / 2, -CUBE / 2 - 0.01);
    group.add(back);

    // Frame around the well.
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.3, metalness: 0.6 });
    const addBar = (w, h, x, y) => {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 1.1), frameMat);
      bar.position.set(x, y, 0);
      group.add(bar);
    };
    addBar(FRAME, Height + FRAME * 2, -FRAME / 2, -Height / 2);
    addBar(FRAME, Height + FRAME * 2, Width + FRAME / 2, -Height / 2);
    addBar(Width, FRAME, Width / 2, -Height - FRAME / 2);

    const text = (x, y, width, height, color, opts = {}) => {
      const plane = new TextPlane({ width, height, color, ...opts });
      plane.mesh.position.set(x, y, 0.6);
      group.add(plane.mesh);
      return plane;
    };

    // Landscape: info column right of the well.
    const landscape = {
      score: text(11, 0, 7, 0.8, '#ffffff'),
      lines: text(11, -0.9, 7, 0.8, '#ffffff'),
      level: text(11, -1.8, 7, 0.8, '#ffffff'),
      hold: text(11, -3.4, 7, 0.8, '#ffff00'),
      next: text(11, -9.4, 7, 0.8, '#9acd32'),
      player: text(11, -19.2, 7, 0.8, '#aaaaaa', { fontScale: 0.45 }),
    };
    landscape.hold.set('HOLD');
    landscape.next.set('NEXT');
    landscape.player.set(`P${i + 1}`);

    // Portrait: three stat columns, then hold / powers / next above the well.
    const col = [0, 3.55, 7.1];
    const label = (x, y, str, color = '#b8c0cc') => {
      const t = text(x, y, 3.2, 0.5, color, { fontScale: 0.6 });
      t.set(str);
      return t;
    };
    const portrait = {
      scoreLabel: label(col[0], 5.5, 'SCORE'),
      linesLabel: label(col[1], 5.5, 'LINES'),
      levelLabel: label(col[2], 5.5, 'LEVEL'),
      score: text(col[0], 5.0, 3.3, 0.8, '#ffffff', { fontScale: 0.6 }),
      lines: text(col[1], 5.0, 3.3, 0.8, '#ffffff', { fontScale: 0.6 }),
      level: text(col[2], 5.0, 3.3, 0.8, '#ffffff', { fontScale: 0.6 }),
      hold: label(col[0], 3.8, 'HOLD', '#ffff00'),
      powers: label(col[1], 3.8, 'POWER', '#ff9a3c'),
      next: label(col[2], 3.8, 'NEXT', '#9acd32'),
    };

    const banner = new TextPlane({ width: Width, height: 1.6, align: 'center', fontScale: 0.55 });
    banner.mesh.position.set(Width / 2, -6, 1.2);
    const bannerBack = new THREE.Mesh(
      new THREE.PlaneGeometry(Width, 2.2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    bannerBack.position.set(Width / 2, -6.8, 1.1);
    bannerBack.renderOrder = 9;
    group.add(bannerBack, banner.mesh);

    return { group, landscape, portrait, banner, bannerBack };
  }

  refreshText() {
    for (const b of this.boards) {
      for (const t of [...Object.values(b.landscape), ...Object.values(b.portrait), b.banner]) t.refresh();
    }
  }

  /** Portrait HUD only for a single board on a tall screen. */
  chooseLayout(aspect) {
    return this.boards.length === 1 && aspect < 0.85 ? 'portrait' : 'landscape';
  }

  applyLayout(name) {
    this.layout = name;
    const { bounds } = LAYOUTS[name];
    const spanW = bounds.maxX - bounds.minX;
    const count = this.boards.length;
    const totalW = count * spanW + (count - 1) * PLAYER_GAP;
    const top = -(bounds.maxY + bounds.minY) / 2; // centre vertically on y = 0

    this.boards.forEach((board, i) => {
      const ox = -totalW / 2 - bounds.minX + i * (spanW + PLAYER_GAP);
      board.group.position.set(ox, top, 0);
      for (const t of Object.values(board.landscape)) t.mesh.visible = name === 'landscape';
      for (const t of Object.values(board.portrait)) t.mesh.visible = name === 'portrait';
    });
    return { fitW: totalW + 1, fitH: bounds.maxY - bounds.minY + 1 };
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;

    // Fit the whole play area (boards, info and power rows).
    const { fitW, fitH } = this.applyLayout(this.chooseLayout(w / h));
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.baseDistance = Math.max(fitH / 2 / tan, fitW / 2 / (tan * this.camera.aspect));
    this.camera.updateProjectionMatrix();
    this.pxPerUnit = h / (2 * this.baseDistance * tan);

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

    game.players.forEach((field, i) => this.boards[i] && this.drawPlayer(game, field, this.boards[i]));

    for (const m of [...this.solid, ...this.ghost]) m.instanceMatrix.needsUpdate = true;
    this.updateCamera(dtMs);
    this.renderer.render(this.scene, this.camera);
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

  /** Pushes a block at board-local cell coordinates. */
  pushCell(board, meshes, value, x, y, z = 0) {
    const o = board.group.position;
    this.pushBlock(meshes, value, o.x + x + 0.5, o.y - y - 0.5, z);
  }

  /** Draws a piece in the well at row `row` (its posY, or the ghost row). */
  drawPiece(board, piece, row, meshes = this.solid) {
    if (!piece) return;
    piece.shape.forEach((cells, y) => {
      if (row + y < 0) return;
      cells.forEach((v, x) => {
        if (v !== 0) this.pushCell(board, meshes, v, piece.posX + x, row + y);
      });
    });
  }

  /**
   * Draws a hold / next preview at a layout slot. Empty rows and columns of
   * the piece matrix are trimmed so every piece sits at the slot's top-left,
   * vertically centred in a two-row box.
   */
  drawPreview(board, piece, slot) {
    if (!piece) return;
    const filled = [];
    piece.shape.forEach((cells, y) => cells.forEach((v, x) => v !== 0 && filled.push([x, y, v])));
    const minX = Math.min(...filled.map((c) => c[0]));
    const minY = Math.min(...filled.map((c) => c[1]));
    const rows = Math.max(...filled.map((c) => c[1])) - minY + 1;
    const o = board.group.position;
    const s = slot.scale;
    const top = o.y + slot.y - (Math.max(0, 2 - rows) / 2) * s;
    for (const [x, y, v] of filled) {
      this.pushBlock(this.solid, v, o.x + slot.x + (x - minX + 0.5) * s, top - (y - minY + 0.5) * s, 0, s);
    }
  }

  drawPlayer(game, field, board) {
    const layout = LAYOUTS[this.layout];

    if (field.isGameOver) {
      // Rainbow fill, like the original game-over screen.
      for (let y = 0; y < Height; y++) {
        for (let x = 0; x < Width; x++) this.pushCell(board, this.solid, (y % 7) + 1, x, y);
      }
    } else {
      for (let y = 0; y < Height; y++) {
        for (let x = 0; x < Width; x++) {
          const v = field.field[y][x];
          if (v === 0) continue;
          // Power blocks bob gently so they stand out.
          const z = v >= 8 ? Math.sin(this.time * 4 + x + y) * 0.12 : 0;
          this.pushCell(board, this.solid, v, x, y, z);
        }
      }
      const piece = field.currentPiece;
      // A RemoteField has no ghost piece.
      if (piece && !field.isRemote && field.shadowY > 0) this.drawPiece(board, piece, field.shadowY, this.ghost);
      if (piece) this.drawPiece(board, piece, piece.posY);
    }

    // Collected powers; the first one is next to be used, so it's drawn bigger.
    const o = board.group.position;
    const p = layout.powers;
    field.powers.forEach((power, idx) => {
      const scale = idx === 0 ? p.scale : p.rest;
      this.pushBlock(this.solid, power, o.x + p.x + (idx + 0.5) * p.step, o.y + p.y - 0.5 * p.step, 0, scale);
    });

    this.drawPreview(board, field.heldPiece, layout.hold);
    this.drawPreview(board, field.nextPiece, layout.next);

    const { landscape, portrait } = board;
    landscape.score.set(`SCORE ${field.score}`);
    landscape.lines.set(`LINES ${field.lines}`);
    landscape.level.set(`LEVEL ${field.level + 1}`);
    portrait.score.set(`${field.score}`);
    portrait.lines.set(`${field.lines}`);
    portrait.level.set(`${field.level + 1}`);

    let banner = '';
    if (game.pause) banner = 'PAUSE';
    else if (field.isWinner) banner = 'WINNER';
    else if (game.allOut) banner = game.players.length > 1 ? 'DRAW' : 'GAME OVER';
    board.banner.set(banner);
    board.banner.mesh.visible = board.bannerBack.visible = banner !== '';
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
