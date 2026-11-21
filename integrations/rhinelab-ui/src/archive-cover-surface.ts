import * as THREE from "three";

export const COVER_FACE = {
  width: 5,
  height: 3.7,
  centerY: 1.85,
  z: 0.27,
  textureWidth: 1000,
  textureHeight: 740,
} as const;

/** One face and UV layout are shared by the wave, extracted card and viewer. */
export function createArchiveCoverMesh(texture: THREE.Texture) {
  const left = -COVER_FACE.width / 2, right = COVER_FACE.width / 2;
  const bottom = -COVER_FACE.height / 2, top = COVER_FACE.height / 2;
  const radius = 0.055;
  const shape = new THREE.Shape();
  shape.moveTo(left + radius, bottom);
  shape.lineTo(right - radius, bottom);
  shape.quadraticCurveTo(right, bottom, right, bottom + radius);
  shape.lineTo(right, top - radius);
  shape.quadraticCurveTo(right, top, right - radius, top);
  shape.lineTo(left + radius, top);
  shape.quadraticCurveTo(left, top, left, top - radius);
  shape.lineTo(left, bottom + radius);
  shape.quadraticCurveTo(left, bottom, left + radius, bottom);
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape, 5);
  const positions = geometry.getAttribute("position"), uv = geometry.getAttribute("uv");
  for (let index = 0; index < positions.count; index++) {
    uv.setXY(index,
      THREE.MathUtils.clamp((positions.getX(index) - left) / COVER_FACE.width, 0, 1),
      THREE.MathUtils.clamp((positions.getY(index) - bottom) / COVER_FACE.height, 0, 1));
  }
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    map: texture,
    toneMapped: false,
    transparent: true,
    depthWrite: true,
    alphaTest: 0.01,
  }));
  mesh.name = "archive-cover-artwork";
  mesh.position.set(0, COVER_FACE.centerY, COVER_FACE.z);
  mesh.userData.printedCanvas = true;
  mesh.userData.coverArtwork = true;
  mesh.updateMatrix();
  return mesh;
}
