import * as THREE from 'three';

export const FONT = '"Press Start 2P", "Courier New", monospace';

/** A flat mesh showing a single line of text drawn onto a canvas texture. */
export class TextPlane {
  constructor({ width, height, color = '#ffffff', align = 'left', pxPerUnit = 96, fontScale = 0.62 }) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(width * pxPerUnit);
    this.canvas.height = Math.round(height * pxPerUnit);
    this.ctx = this.canvas.getContext('2d');
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

  set(text, color = this.color) {
    if (text === this.text && color === this.drawnColor) return;
    this.text = text;
    this.drawnColor = color;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${Math.round(canvas.height * this.fontScale)}px ${FONT}`;
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
