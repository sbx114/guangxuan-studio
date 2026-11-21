import { AppError } from './errors.mjs';

const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TYPES = new Set(['video', 'image', 'audio']);

/** Only the current native library and the project's trusted reference registry
 * establish membership. A reference grants reading, never a native import receipt. */
export async function collectProjectMedia(projectId, { nativeAssets = [], references, videoService } = {}) {
  const assets = new Map(), registrations = new Map();
  for (const asset of nativeAssets) {
    if (!asset || !ASSET_ID.test(asset.id || '') || !TYPES.has(asset.type)) continue;
    assets.set(asset.id, asset);
    registrations.set(asset.id, { nativeImported: true, referenceIds: [] });
  }
  const state = references?.list ? await references.list(projectId) : null;
  for (const item of state?.items || []) {
    if (!['video', 'image'].includes(item.type)) continue;
    if (!ASSET_ID.test(item.assetId || '') || typeof item.id !== 'string') throw new AppError(422, '项目参考素材登记无效，请重新导入参考。', 'PROJECT_MEDIA_REFERENCE_INVALID');
    if (!assets.has(item.assetId)) {
      if (!videoService?.resolveAsset) throw new AppError(503, '参考媒体库尚未就绪。', 'PROJECT_MEDIA_UNAVAILABLE');
      const asset = await videoService.resolveAsset(item.assetId);
      if (asset?.id !== item.assetId || asset.type !== item.type) throw new AppError(422, '项目参考素材已失效，请重新导入参考。', 'PROJECT_MEDIA_REFERENCE_INVALID');
      assets.set(asset.id, asset);
      registrations.set(asset.id, { nativeImported: false, referenceIds: [] });
    } else if (assets.get(item.assetId).type !== item.type) throw new AppError(422, '项目参考素材类型已经变化。', 'PROJECT_MEDIA_REFERENCE_INVALID');
    registrations.get(item.assetId).referenceIds.push(item.id);
  }
  return { assets: [...assets.values()], registrations, ...(state ? { referenceRevision: state.revision } : {}) };
}
