import * as THREE from 'three';
import { Width, Height } from '../game/tetrisField.ts';
import type { Board, GameScreen } from '../game/gameScreen.ts';
import type { Tetromino } from '../game/tetromino.ts';
import { TextPlane, type TextPlaneOptions } from './textPlane.ts';

const BASE = import.meta.env.BASE_URL + 'assets/';
const BLOCK_TYPES = 11; // block1.png .. block11.png map to field values 1..11
const MAX_BOARDS = 2;
const PLAYER_GAP = 3;
const CUBE = 0.92;
const FRAME = 0.3;
const PORTRAIT_ASPECT = 0.85; // narrower than this: portrait HUD
const MINI_SCALE = { landscape: 0.45, portrait: 0.3 };
const MINI_GAP = 0.8; // between the landscape info column and the mini board
const FLASH_MS = 350;
const FLASH_COLORS = { hit: new THREE.Color(0xff2020), attack: new THREE.Color(0xff9a3c) };

export type FlashKind = keyof typeof FLASH_COLORS;
type LayoutName = 'landscape' | 'portrait' | 'portraitDuo' | 'mini';
type PortraitLayout = 'portrait' | 'portraitDuo';

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Where a hold / next preview goes, in board-local units. */
interface Slot {
  x: number;
  y: number;
  scale: number;
}

interface Layout {
  bounds: Bounds;
  hold?: Slot;
  next?: Slot;
  // The power row: `scale` for the first power, `rest` for the others.
  powers: { x: number; y: number; step: number; scale: number; rest: number };
}

/** A board to draw: `mini` is the online opponent. */
export interface BoardSpec {
  mini?: boolean;
}

/** Everything drawn for one board. */
interface BoardView {
  index: number;
  mini: boolean;
  layout: LayoutName;
  x: number;
  y: number;
  scale: number;
  group: THREE.Group;
  frameMat: THREE.MeshStandardMaterial;
  flash: number;
  flashColor: THREE.Color;
  landscape: Record<string, TextPlane>;
  portrait: Record<string, TextPlane>;
  miniText: Record<string, TextPlane>;
  banner: TextPlane;
  bannerBack: THREE.Mesh;
}

/*
 * Each board is a group whose origin is the top-left corner of the well, so
 * cell (x, y) sits at local (x + 0.5, -y - 0.5), times the board's scale.
 * Layouts place the info around the well:
 *   landscape:   score, hold and next to the right of the well (desktop, versus)
 *   portrait:    a compact HUD above the well (phones held upright)
 *   portraitDuo: portrait with room for the opponent's mini board in the HUD
 *   mini:        the online opponent: well, piece and powers, name and score
 *                above; no ghost, hold or next
 * Bounds are the local extents used to centre and fit the camera.
 */
const LAYOUTS: Record<LayoutName, Layout> = {
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
  portraitDuo: {
    bounds: { minX: -FRAME, maxX: Width + FRAME, minY: -Height - FRAME, maxY: 8.9 },
    hold: { x: 0.1, y: 6.2, scale: 0.6 },
    next: { x: 3.7, y: 6.2, scale: 0.6 },
    powers: { x: 0.05, y: 3.5, step: 0.66, scale: 0.6, rest: 0.5 },
  },
  mini: {
    bounds: { minX: -FRAME, maxX: Width + FRAME, minY: -22.1, maxY: 5.4 },
    powers: { x: 1, y: -21, step: 1, scale: 1, rest: 0.8 },
  },
};

// Where the portrait HUD texts go: [x, y, scale] per layout.
const PORTRAIT_TEXT: Record<PortraitLayout, Record<string, [number, number, number]>> = {
  portrait: {
    scoreLabel: [0, 5.5, 1],
    linesLabel: [3.55, 5.5, 1],
    levelLabel: [7.1, 5.5, 1],
    score: [0, 5.0, 1],
    lines: [3.55, 5.0, 1],
    level: [7.1, 5.0, 1],
    hold: [0, 3.8, 1],
    powers: [3.55, 3.8, 1],
    next: [7.1, 3.8, 1],
  },
  portraitDuo: {
    scoreLabel: [0, 8.8, 0.9],
    linesLabel: [2.7, 8.8, 0.9],
    levelLabel: [5.2, 8.8, 0.9],
    score: [0, 8.3, 0.9],
    lines: [2.7, 8.3, 0.9],
    level: [5.2, 8.3, 0.9],
    hold: [0, 6.9, 0.9],
    powers: [0, 4.1, 0.9],
    next: [3.6, 6.9, 0.9],
  },
};

/** Normalises setBoards() input to one { mini } spec per board. */
function boardSpecs(boards: number | BoardSpec[]): Required<BoardSpec>[] {
  const specs: BoardSpec[] = typeof boards === 'number' ? Array.from({ length: boards }, () => ({})) : boards;
  return specs.slice(0, MAX_BOARDS).map((s) => ({ mini: !!s.mini }));
}

/**
 * Three.js view of a GameScreen. Every frame the block instances are rebuilt
 * from the game state, so rendering holds no game logic of its own.
 */
export class Renderer {
  container: HTMLElement;
  pxPerUnit: number;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  baseDistance: number;
  shake: number;
  time: number;
  loader: THREE.TextureLoader;
  background!: THREE.Mesh;
  solid!: THREE.InstancedMesh[];
  ghost!: THREE.InstancedMesh[];
  tmp!: THREE.Object3D;
  boards: BoardView[];

  /** @param boards how many boards to draw, or specs (see setBoards) */
  constructor(container: HTMLElement, boards: number | BoardSpec[] = 1) {
    this.container = container;
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

  /**
   * Replaces the boards, e.g. when switching between solo and online play.
   * @param boards a count, or [{ mini }] per board; a mini board is the
   *   online opponent, drawn small next to (or above) board 0
   */
  setBoards(boards: number | BoardSpec[]) {
    for (const board of this.boards) this.disposeBoard(board);
    const specs = boardSpecs(boards);
    const online = specs.some((s) => s.mini);
    this.boards = specs.map((spec, i) => this.createBoard(i, { ...spec, labelled: !online }));
    this.resize();
  }

  disposeBoard(board: BoardView) {
    this.scene.remove(board.group);
    board.group.traverse((obj) => {
      const mesh = obj as Partial<THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>;
      mesh.geometry?.dispose();
      mesh.material?.map?.dispose();
      mesh.material?.dispose();
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
    // Background dimmed to 50% over black.
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

  createBoard(i: number, { mini = false, labelled = true }: { mini?: boolean; labelled?: boolean } = {}): BoardView {
    const group = new THREE.Group();
    this.scene.add(group);

    // Field background (white at 10%), pushed behind the cubes.
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(Width, Height),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, depthWrite: false }),
    );
    back.position.set(Width / 2, -Height / 2, -CUBE / 2 - 0.01);
    group.add(back);

    // Frame around the well; its glow flashes on attacks.
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.3, metalness: 0.6 });
    const addBar = (w: number, h: number, x: number, y: number) => {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 1.1), frameMat);
      bar.position.set(x, y, 0);
      group.add(bar);
    };
    addBar(FRAME, Height + FRAME * 2, -FRAME / 2, -Height / 2);
    addBar(FRAME, Height + FRAME * 2, Width + FRAME / 2, -Height / 2);
    addBar(Width, FRAME, Width / 2, -Height - FRAME / 2);

    const text = (
      x: number,
      y: number,
      width: number,
      height: number,
      color: string,
      opts: Partial<TextPlaneOptions> = {},
    ) => {
      const plane = new TextPlane({ width, height, color, ...opts });
      plane.mesh.position.set(x, y, 0.6);
      group.add(plane.mesh);
      return plane;
    };

    // Landscape: info column right of the well.
    const landscape: Record<string, TextPlane> = mini
      ? {}
      : {
          score: text(11, 0, 7, 0.8, '#ffffff'),
          lines: text(11, -0.9, 7, 0.8, '#ffffff'),
          level: text(11, -1.8, 7, 0.8, '#ffffff'),
          hold: text(11, -3.4, 7, 0.8, '#ffff00'),
          next: text(11, -9.4, 7, 0.8, '#9acd32'),
        };
    if (!mini) {
      landscape.hold.set('HOLD');
      landscape.next.set('NEXT');
      // Local 2-player labels its boards; online the local board is not labelled.
      if (labelled) {
        landscape.player = text(11, -19.2, 7, 0.8, '#aaaaaa', { fontScale: 0.45 });
        landscape.player.set(`P${i + 1}`);
      }
    }

    // Portrait: three stat columns, then hold / powers / next above the well.
    const label = (str: string, color = '#b8c0cc') => {
      const t = text(0, 0, 3.2, 0.5, color, { fontScale: 0.6 });
      t.set(str);
      return t;
    };
    const portrait: Record<string, TextPlane> = mini
      ? {}
      : {
          scoreLabel: label('SCORE'),
          linesLabel: label('LINES'),
          levelLabel: label('LEVEL'),
          score: text(0, 0, 3.3, 0.8, '#ffffff', { fontScale: 0.6 }),
          lines: text(0, 0, 3.3, 0.8, '#ffffff', { fontScale: 0.6 }),
          level: text(0, 0, 3.3, 0.8, '#ffffff', { fontScale: 0.6 }),
          hold: label('HOLD', '#ffff00'),
          powers: label('POWER', '#ff9a3c'),
          next: label('NEXT', '#9acd32'),
        };

    // Mini: the opponent's name and score above the well, large enough to
    // read at mini scale.
    const miniText: Record<string, TextPlane> = mini
      ? {
          name: text(0, 5.3, Width, 2.4, '#ff9a3c', { fontScale: 0.62 }),
          score: text(0, 2.8, Width, 2.2, '#ffffff', { fontScale: 0.6 }),
        }
      : {};

    const banner = new TextPlane({ width: Width, height: 1.6, align: 'center', fontScale: 0.55 });
    banner.mesh.position.set(Width / 2, -6, 1.2);
    const bannerBack = new THREE.Mesh(
      new THREE.PlaneGeometry(Width, 2.2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    bannerBack.position.set(Width / 2, -6.8, 1.1);
    bannerBack.renderOrder = 9;
    group.add(bannerBack, banner.mesh);

    return {
      index: i,
      mini,
      layout: mini ? 'mini' : 'landscape',
      x: 0,
      y: 0,
      scale: 1,
      group,
      frameMat,
      flash: 0,
      flashColor: FLASH_COLORS.hit,
      landscape,
      portrait,
      miniText,
      banner,
      bannerBack,
    };
  }

  refreshText() {
    for (const b of this.boards) {
      const texts = [...Object.values(b.landscape), ...Object.values(b.portrait), ...Object.values(b.miniText), b.banner];
      for (const t of texts) t.refresh();
    }
  }

  /**
   * Places every board and returns the size of the area the camera must fit.
   * Without a mini board, full-size boards sit side by side (a single one
   * gets the portrait HUD on a tall screen). With one, it goes right of the
   * landscape info column, or into the portrait HUD.
   */
  applyLayout(aspect: number): { fitW: number; fitH: number } {
    const tall = aspect < PORTRAIT_ASPECT;
    const mini = this.boards.find((b) => b.mini);
    const full = this.boards.filter((b) => !b.mini);
    const place = (board: BoardView, layout: LayoutName, x: number, y: number, scale: number) =>
      Object.assign(board, { layout, x, y, scale });

    if (mini) {
      const main = full[0];
      const layout = tall ? 'portraitDuo' : 'landscape';
      const mb = LAYOUTS[layout].bounds;
      const nb = LAYOUTS.mini.bounds;
      place(main, layout, 0, 0, 1);
      if (tall) {
        // Top-right corner of the HUD, above the well.
        const s = MINI_SCALE.portrait;
        place(mini, 'mini', mb.maxX - nb.maxX * s, mb.maxY - nb.maxY * s, s);
      } else {
        const s = MINI_SCALE.landscape;
        place(mini, 'mini', mb.maxX + MINI_GAP - nb.minX * s, mb.maxY - nb.maxY * s, s);
      }
    } else {
      const layout = full.length === 1 && tall ? 'portrait' : 'landscape';
      const b = LAYOUTS[layout].bounds;
      const spanW = b.maxX - b.minX;
      full.forEach((board, i) => place(board, layout, i * (spanW + PLAYER_GAP), 0, 1));
    }

    // Centre the union of all boards on the origin.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const board of this.boards) {
      const b = LAYOUTS[board.layout].bounds;
      minX = Math.min(minX, board.x + b.minX * board.scale);
      maxX = Math.max(maxX, board.x + b.maxX * board.scale);
      minY = Math.min(minY, board.y + b.minY * board.scale);
      maxY = Math.max(maxY, board.y + b.maxY * board.scale);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    for (const board of this.boards) {
      board.group.position.set(board.x - cx, board.y - cy, 0);
      board.group.scale.setScalar(board.scale);
      const portrait = board.layout === 'portrait' || board.layout === 'portraitDuo';
      for (const t of Object.values(board.landscape)) t.mesh.visible = board.layout === 'landscape';
      for (const [key, t] of Object.entries(board.portrait)) {
        t.mesh.visible = portrait;
        if (!portrait) continue;
        const [x, y, s] = PORTRAIT_TEXT[board.layout as PortraitLayout][key];
        t.mesh.position.set(x, y, 0.6);
        t.mesh.scale.setScalar(s);
      }
    }
    return { fitW: maxX - minX + 1, fitH: maxY - minY + 1 };
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;

    // Fit the whole play area (boards, info and power rows).
    const { fitW, fitH } = this.applyLayout(w / h);
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

  addShake(amount: number) {
    this.shake = Math.max(this.shake, amount);
  }

  /**
   * Lights up a board's frame for a moment: 'hit' (red) when an attack lands
   * on it, 'attack' (orange) when we send one to it.
   */
  flash(i: number, kind: FlashKind = 'hit') {
    const board = this.boards[i];
    if (!board) return;
    board.flash = 1;
    board.flashColor = FLASH_COLORS[kind] ?? FLASH_COLORS.hit;
  }

  draw(game: GameScreen, dtMs: number) {
    this.time += dtMs / 1000;
    for (const m of this.solid) m.count = 0;
    for (const m of this.ghost) m.count = 0;

    game.players.forEach((field, i) => this.boards[i] && this.drawPlayer(game, field, this.boards[i]));
    for (const board of this.boards) this.updateFlash(board, dtMs);

    for (const m of [...this.solid, ...this.ghost]) m.instanceMatrix.needsUpdate = true;
    this.updateCamera(dtMs);
    this.renderer.render(this.scene, this.camera);
  }

  updateFlash(board: BoardView, dtMs: number) {
    if (board.flash <= 0) return;
    board.flash = Math.max(0, board.flash - dtMs / FLASH_MS);
    board.frameMat.emissive.copy(board.flashColor).multiplyScalar(board.flash * 1.5);
  }

  pushBlock(meshes: THREE.InstancedMesh[], value: number, wx: number, wy: number, z = 0, scale = 1) {
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
  pushCell(board: BoardView, meshes: THREE.InstancedMesh[], value: number, x: number, y: number, z = 0) {
    const o = board.group.position;
    const s = board.scale;
    this.pushBlock(meshes, value, o.x + (x + 0.5) * s, o.y - (y + 0.5) * s, z * s, s);
  }

  /** Draws a piece in the well at row `row` (its posY, or the ghost row). */
  drawPiece(board: BoardView, piece: Tetromino | null, row: number, meshes = this.solid) {
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
  drawPreview(board: BoardView, piece: Tetromino | null, slot: Slot | undefined) {
    if (!piece || !slot) return;
    const filled: [number, number, number][] = [];
    piece.shape.forEach((cells, y) => cells.forEach((v, x) => v !== 0 && filled.push([x, y, v])));
    const minX = Math.min(...filled.map((c) => c[0]));
    const minY = Math.min(...filled.map((c) => c[1]));
    const rows = Math.max(...filled.map((c) => c[1])) - minY + 1;
    const o = board.group.position;
    const bs = board.scale;
    const s = slot.scale;
    const top = slot.y - (Math.max(0, 2 - rows) / 2) * s;
    for (const [x, y, v] of filled) {
      const lx = slot.x + (x - minX + 0.5) * s;
      const ly = top - (y - minY + 0.5) * s;
      this.pushBlock(this.solid, v, o.x + lx * bs, o.y + ly * bs, 0, s * bs);
    }
  }

  drawPlayer(game: GameScreen, field: Board, board: BoardView) {
    const layout = LAYOUTS[board.layout];

    if (field.isGameOver) {
      // Rainbow fill on game over.
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
      // The mini board (and any RemoteField) has no ghost piece.
      if (piece && !board.mini && !field.isRemote && field.shadowY > 0) {
        this.drawPiece(board, piece, field.shadowY, this.ghost);
      }
      if (piece) this.drawPiece(board, piece, piece.posY);
    }

    // Collected powers; the first one is next to be used, so it's drawn bigger.
    const o = board.group.position;
    const bs = board.scale;
    const p = layout.powers;
    field.powers.forEach((power, idx) => {
      const scale = idx === 0 ? p.scale : p.rest;
      this.pushBlock(this.solid, power, o.x + (p.x + (idx + 0.5) * p.step) * bs, o.y + (p.y - 0.5 * p.step) * bs, 0, scale * bs);
    });

    if (board.mini) {
      board.miniText.name.set(game.names?.[board.index] ?? `P${board.index + 1}`);
      board.miniText.score.set(`${field.score}`);
    } else {
      this.drawPreview(board, field.heldPiece, layout.hold);
      this.drawPreview(board, field.nextPiece, layout.next);
      const { landscape, portrait } = board;
      landscape.score.set(`SCORE ${field.score}`);
      landscape.lines.set(`LINES ${field.lines}`);
      landscape.level.set(`LEVEL ${field.level + 1}`);
      portrait.score.set(`${field.score}`);
      portrait.lines.set(`${field.lines}`);
      portrait.level.set(`${field.level + 1}`);
    }

    const banner = this.bannerText(game, field, board.index);
    board.banner.set(banner);
    board.banner.mesh.visible = board.bannerBack.visible = banner !== '';
  }

  bannerText(game: GameScreen, field: Board, i: number): string {
    if (game.online) {
      // The host's result, else pause, else the 3-2-1 countdown on our own board.
      if (game.result === 'draw') return 'DRAW';
      if (game.result !== null) return game.result === i ? `${game.names?.[i] ?? ''} WINS`.trim() : '';
      if (game.pause) return 'PAUSE';
      if (game.countdown > 0 && i === 0) return String(Math.ceil(game.countdown / 1000));
      return '';
    }
    if (game.pause) return 'PAUSE';
    if (field.isWinner) return 'WINNER';
    if (game.allOut) return game.players.length > 1 ? 'DRAW' : 'GAME OVER';
    return '';
  }

  updateCamera(dtMs: number) {
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
