import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { renderDimensions, type RenderQuality } from "./render-quality";

const composerSizes = new WeakMap<EffectComposer, { width: number; height: number }>();

export function applyTextureQuality(
  root: THREE.Object3D,
  renderer: THREE.WebGLRenderer,
  quality: RenderQuality,
) {
  const maximum = Math.min(
    quality.anisotropy,
    renderer.capabilities.getMaxAnisotropy(),
  );
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture && !value.isRenderTargetTexture)
          textures.add(value);
      }
    }
  });
  for (const texture of textures) {
    if (texture.anisotropy === maximum) continue;
    texture.anisotropy = maximum;
    texture.needsUpdate = true;
  }
}

export function resizeQuality(
  renderer: THREE.WebGLRenderer,
  composer: EffectComposer,
  host: HTMLElement,
  quality: RenderQuality,
  superPerformance = false,
) {
  const width = Math.max(1, host.clientWidth),
    height = Math.max(1, host.clientHeight);
  const dimensions = renderDimensions(
    quality,
    width,
    height,
    host.getBoundingClientRect().width / width,
    devicePixelRatio,
    renderer.capabilities.maxTextureSize,
    superPerformance ? 921_600 : 8_294_400,
  );
  // Keep the GPU pipeline in physical pixels and let CSS own the stage units.
  // For example, 1280x1516 at .594 stage scale and 760x900 at scale 1 both
  // need the same 760x900 image. Updating the renderer's logical size/ratio
  // separately would clear the prepared canvas twice at that layout cut.
  const current = renderer.getSize(new THREE.Vector2());
  if (renderer.getPixelRatio() !== 1 || current.x !== dimensions.width || current.y !== dimensions.height)
    renderer.setDrawingBufferSize(dimensions.width, dimensions.height, 1);
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  const previous = composerSizes.get(composer);
  if (!previous) composer.setPixelRatio(1);
  if (!previous || previous.width !== dimensions.width || previous.height !== dimensions.height)
    composer.setSize(dimensions.width, dimensions.height);
  composerSizes.set(composer, { width: dimensions.width, height: dimensions.height });
  renderer.transmissionResolutionScale = quality.transmission;
  host.dataset.renderQuality = JSON.stringify({
    ...dimensions,
    antialias: quality.antialias,
    transmission: quality.transmission,
    anisotropy: Math.min(
      quality.anisotropy,
      renderer.capabilities.getMaxAnisotropy(),
    ),
    superPerformance,
  });
  return dimensions;
}

export function createViewerPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
) {
  const composer = new EffectComposer(renderer);
  const smaa = new SMAAPass();
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(smaa);
  composer.addPass(new OutputPass());
  return { composer, smaa };
}
