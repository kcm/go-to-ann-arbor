import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function colored(geometry, hex) {
  const color = new THREE.Color(hex);
  const values = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 0; i < values.length; i += 3) color.toArray(values, i);
  geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
  return geometry;
}

function box(width, height, depth, x, y, z, color) {
  return colored(new THREE.BoxGeometry(width, height, depth).translate(x, y, z), color);
}

function merged(geometries) {
  const result = mergeGeometries(geometries);
  for (const geometry of geometries) geometry.dispose();
  return result;
}

function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function atlasPlane(width, height, rect, x, y, z, rotationX = 0, rotationY = 0) {
  const geometry = new THREE.PlaneGeometry(width, height);
  const uv = geometry.attributes.uv;
  const [left, top, w, h] = rect;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, left + uv.getX(i) * w, 1 - top - h + uv.getY(i) * h);
  }
  return geometry.rotateX(rotationX).rotateY(rotationY).translate(x, y, z);
}

export function createFoodCartParts() {
  const steel = [];
  const trim = [];
  steel.push(box(1.3, 0.75, 2.04, 0, 0.88, 0, 0xabb7b8));
  steel.push(box(1.5, 0.09, 2.2, 0, 1.29, 0, 0xe2e6df));
  steel.push(box(1.23, 0.06, 1.38, 0, 1.77, -0.32, 0xe2e6df));
  for (const x of [-0.58, 0.58]) {
    for (const z of [-0.97, 0.33]) steel.push(box(0.035, 0.45, 0.035, x, 1.53, z, 0xc9d3d1));
    for (const z of [-0.73, 0.73]) {
      trim.push(colored(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 8).rotateZ(Math.PI / 2).translate(x + Math.sign(x) * 0.07, 0.44, z), 0x242a29));
    }
  }
  // Recessed food pans and lids sit behind the serving counter.
  for (const z of [-0.7, -0.12]) {
    steel.push(box(1.05, 0.045, 0.46, 0, 1.355, z, 0x4f5b59));
    steel.push(box(0.94, 0.035, 0.36, 0, 1.38, z, 0xced2c4));
  }
  for (const [x, color] of [[-0.43, 0xd13120], [-0.22, 0xf0bf20]]) {
    trim.push(colored(new THREE.CylinderGeometry(0.055, 0.065, 0.21, 6).translate(x, 1.44, 0.77), color));
    trim.push(colored(new THREE.ConeGeometry(0.035, 0.07, 6).translate(x, 1.58, 0.77), color));
  }
  steel.push(colored(new THREE.CylinderGeometry(0.027, 0.027, 1.62, 6).translate(0.13, 2.1, -0.17), 0xe0e1d4));

  const canopy = new THREE.BufferGeometry();
  const vertices = [];
  const colors = [];
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    const b = (i + 1) * Math.PI / 4;
    const x1 = Math.cos(a) * 1.58 + 0.13, z1 = Math.sin(a) * 1.58 - 0.17;
    const x2 = Math.cos(b) * 1.58 + 0.13, z2 = Math.sin(b) * 1.58 - 0.17;
    vertices.push(0.13, 2.91, -0.17, x2, 2.46, z2, x1, 2.46, z1);
    vertices.push(x1, 2.46, z1, x2, 2.46, z2, x2, 2.32, z2, x1, 2.46, z1, x2, 2.32, z2, x1, 2.32, z1);
    const color = new THREE.Color(i % 2 ? 0xf4bd33 : 0x2361a4);
    for (let j = 0; j < 9; j++) color.toArray(colors, colors.length);
  }
  canopy.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  canopy.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  canopy.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(vertices.length / 3 * 2), 2));
  canopy.computeVertexNormals();
  canopy.setIndex(Array.from({ length: vertices.length / 3 }, (_, i) => i));
  trim.push(canopy);

  const menu = canvasTexture(512, 256, (ctx) => {
    ctx.fillStyle = '#eee8d2';
    ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = '#b62920';
    ctx.fillRect(0, 0, 512, 75);
    ctx.fillStyle = '#fff5dc';
    ctx.textAlign = 'center';
    ctx.font = 'bold 55px Arial, sans-serif';
    ctx.fillText('HOT DOGS', 256, 58);
    ctx.fillStyle = '#41634b';
    ctx.font = 'bold 35px Arial, sans-serif';
    ctx.fillText('HALAL • PRETZELS', 256, 121);
    ctx.fillStyle = '#d79a47';
    ctx.beginPath();
    ctx.roundRect(144, 158, 224, 58, 29);
    ctx.fill();
    ctx.fillStyle = '#934121';
    ctx.beginPath();
    ctx.roundRect(151, 173, 210, 29, 14);
    ctx.fill();
    ctx.strokeStyle = '#efd551';
    ctx.lineWidth = 5;
    ctx.beginPath();
    for (let x = 165; x <= 347; x += 7) {
      const y = 187 + Math.sin(x * 0.12) * 7;
      if (x === 165) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
  const menuPanels = [
    atlasPlane(1.18, 0.59, [0, 0, 1, 1], 0, 0.89, 1.026),
    atlasPlane(1.7, 0.64, [0, 0, 1, 1], -0.656, 0.89, 0, 0, -Math.PI / 2),
    atlasPlane(1.7, 0.64, [0, 0, 1, 1], 0.656, 0.89, 0, 0, Math.PI / 2)
  ];
  const glass = [
    atlasPlane(1.14, 0.38, [0, 0, 1, 1], 0, 1.54, 0.33),
    atlasPlane(1.26, 0.38, [0, 0, 1, 1], -0.58, 1.54, -0.32, 0, -Math.PI / 2),
    atlasPlane(1.26, 0.38, [0, 0, 1, 1], 0.58, 1.54, -0.32, 0, Math.PI / 2)
  ];
  return [
    { name: 'cart-steel', geometry: merged(steel), material: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.36, metalness: 0.72 }) },
    { name: 'cart-trim', geometry: merged(trim), material: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide }) },
    { name: 'cart-menu', geometry: merged(menuPanels), material: new THREE.MeshStandardNodeMaterial({ map: menu, roughness: 0.8 }) },
    { name: 'cart-glass', geometry: merged(glass), material: new THREE.MeshStandardNodeMaterial({ color: 0xb5dbd7, roughness: 0.15, metalness: 0.15, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }), castShadow: false }
  ];
}
