import * as THREE from 'three';

export const FONT = '"Press Start 2P", "Courier New", monospace';

/** A flat mesh showing a single line of text drawn onto a canvas texture. */
export interface TextPlaneOptions {
  width: number;
  height: number;
  color?: string;
  align?: 'left' | 'center';
  pxPerUnit?: number;
  fontScale?: number;
}

export class TextPlane {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  color: string;
  align: 'left' | 'center';
  fontScale: number;
  text: string | null;
  drawnColor: string | undefined;
  texture: THREE.CanvasTexture;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  constructor({ width, height, color = '#ffffff', align = 'left', pxPerUnit = 96, fontScale = 0.62 }: TextPlaneOptions) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(width * pxPerUnit);
    this.canvas.height = Math.round(height * pxPerUnit);
    this.ctx = this.canvas.getContext('2d')!;
    this.color = color;
    this.align = align;
    this.fontScale = fontScale;
    this.text = null;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false });
    const geometry = new THREE.PlaneGeometry(width, height);
    // Anchor the plane at its top-left (or top-center) corner.
    geometry.translate(align === 'center' ? 0 : width / 2, -height / 2, 0);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.renderOrder = 10;
  }

  set(text: string, color = this.color) {
    if (text === this.text && color === this.drawnColor) return;
    this.text = text;
    this.drawnColor = color;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Shrink long text to fit the plane instead of clipping it.
    let size = Math.round(canvas.height * this.fontScale);
    ctx.font = `${size}px ${FONT}`;
    const maxWidth = canvas.width - 8;
    const width = ctx.measureText(text).width;
    if (width > maxWidth) {
      size = Math.floor((size * maxWidth) / width);
      ctx.font = `${size}px ${FONT}`;
    }
    ctx.textBaseline = 'middle';
    ctx.textAlign = this.align;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowOffsetX = ctx.shadowOffsetY = Math.max(2, canvas.height * 0.04);
    ctx.fillStyle = color;
    const x = this.align === 'center' ? canvas.width / 2 : 4;
    ctx.fillText(text, x, canvas.height / 2);
    this.texture.needsUpdate = true;
  }

  /** Force a redraw, e.g. after the web font finished loading. */
  refresh() {
    const t = this.text;
    this.text = null;
    if (t != null) this.set(t, this.drawnColor);
  }
}
