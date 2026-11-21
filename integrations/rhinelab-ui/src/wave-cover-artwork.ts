import * as THREE from "three";
import { customCoverUrl, drawArchiveArtwork, normalizeArchiveCover, normalizeCoverAssetId } from "./archive-cover.ts";
import { COVER_FACE, createArchiveCoverMesh } from "./archive-cover-surface.ts";

type CoverRecord = { id: string; cover?: unknown; coverAssetId?: unknown };
type CoverMesh = ReturnType<typeof createArchiveCoverMesh>;
type Asset = {
  surface: CoverMesh;
  texture: THREE.CanvasTexture;
  image?: HTMLImageElement;
  status: "loading" | "ready" | "error";
};
type ProjectMesh = { assetId: string; mesh: CoverMesh };

// 500 × 370 canvases keep this cache below 100 MB of uncompressed RGBA pixels.
const MAX_ASSETS = 128;

/** Only visible, saved projects request pictures; empty wave slots stay untouched. */
export class ArchiveWaveCovers {
  readonly group = new THREE.Group();
  private projects = new Map<string, string>();
  private assets = new Map<string, Asset>();
  private meshes = new Map<string, ProjectMesh>();
  private seenProjects = new Set<string>();
  private seenAssets = new Set<string>();
  private disposed = false;

  constructor(private readonly onChange: () => void, private readonly anisotropy: number) {
    this.group.name = "archive-wave-covers";
  }

  sync(records: readonly CoverRecord[]) {
    if (this.disposed) return;
    const projects = new Map<string, string>();
    for (const record of records) {
      const assetId = normalizeCoverAssetId(record.coverAssetId);
      if (normalizeArchiveCover(record.cover) === "custom" && assetId) projects.set(record.id, assetId);
    }
    const changed = projects.size !== this.projects.size || [...projects].some(([id, assetId]) => this.projects.get(id) !== assetId);
    this.projects = projects;
    for (const [id, entry] of this.meshes) if (projects.get(id) !== entry.assetId) this.removeMesh(id);
    const retained = new Set(projects.values());
    for (const assetId of this.assets.keys()) if (!retained.has(assetId)) this.releaseAsset(assetId);
    if (changed) this.onChange();
  }

  beginFrame() {
    this.seenProjects.clear();
    this.seenAssets.clear();
    for (const entry of this.meshes.values()) entry.mesh.visible = false;
  }

  show(projectId: string, matrix: THREE.Matrix4) {
    if (this.disposed) return;
    const assetId = this.projects.get(projectId);
    if (!assetId) return;
    this.seenProjects.add(projectId);
    const asset = this.assetFor(assetId);
    if (!asset) return;
    this.seenAssets.add(assetId);
    let entry = this.meshes.get(projectId);
    if (!entry || entry.assetId !== assetId) {
      this.removeMesh(projectId);
      const mesh = asset.surface.clone();
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.userData.projectId = projectId;
      entry = { assetId, mesh };
      this.meshes.set(projectId, entry);
      this.group.add(mesh);
    }
    entry.mesh.matrix.multiplyMatrices(matrix, asset.surface.matrix);
    entry.mesh.matrixWorldNeedsUpdate = true;
    entry.mesh.visible = asset.status === "ready";
  }

  endFrame() {
    for (const id of this.meshes.keys()) if (!this.seenProjects.has(id)) this.removeMesh(id);
  }

  get visibleProjectIds() {
    return [...this.meshes].filter(([, entry]) => entry.mesh.visible).map(([id]) => id);
  }

  private assetFor(assetId: string): Asset | undefined {
    const cached = this.assets.get(assetId);
    if (cached) {
      this.assets.delete(assetId);
      this.assets.set(assetId, cached);
      return cached;
    }
    if (this.assets.size >= MAX_ASSETS) {
      const oldest = [...this.assets.keys()].find(id => !this.seenAssets.has(id));
      if (!oldest) return;
      this.releaseAsset(oldest);
    }
    const canvas = document.createElement("canvas");
    canvas.width = COVER_FACE.textureWidth / 2;
    canvas.height = COVER_FACE.textureHeight / 2;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Number.isFinite(this.anisotropy) ? Math.max(1, this.anisotropy) : 1;
    const image = new Image();
    const asset: Asset = { surface: createArchiveCoverMesh(texture), texture, image, status: "loading" };
    this.assets.set(assetId, asset);
    const current = () => !this.disposed && this.assets.get(assetId) === asset && asset.image === image;
    const finish = (ready: boolean) => {
      asset.status = ready ? "ready" : "error";
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      asset.image = undefined;
      this.onChange();
    };
    image.onload = () => {
      if (!current()) return;
      const context = canvas.getContext("2d");
      if (!context || !image.naturalWidth || !image.naturalHeight) { finish(false); return; }
      let ready = false;
      try {
        drawArchiveArtwork(context, "custom", image);
        texture.needsUpdate = true;
        ready = true;
      } catch { /* Leave a failed image transparent until the asset is requested again. */ }
      finish(ready);
    };
    image.onerror = () => { if (current()) finish(false); };
    image.src = customCoverUrl(assetId);
    return asset;
  }

  private removeMesh(projectId: string) {
    const entry = this.meshes.get(projectId);
    if (!entry) return;
    this.group.remove(entry.mesh);
    this.meshes.delete(projectId);
  }

  private releaseAsset(assetId: string) {
    const asset = this.assets.get(assetId);
    if (!asset) return;
    this.assets.delete(assetId);
    for (const [id, entry] of this.meshes) if (entry.assetId === assetId) this.removeMesh(id);
    if (asset.image) {
      asset.image.onload = null;
      asset.image.onerror = null;
      asset.image.removeAttribute("src");
      asset.image = undefined;
    }
    asset.surface.geometry.dispose();
    asset.surface.material.dispose();
    asset.texture.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const assetId of this.assets.keys()) this.releaseAsset(assetId);
    this.projects.clear();
    this.seenProjects.clear();
    this.seenAssets.clear();
    this.group.clear();
  }
}
