/** Shared art is resolved when a reader opens; projects keep profile IDs only. */
export const novelAssetUrl = (projectId, assetId) => '/api/novel-library/assets/' + encodeURIComponent(assetId ?? projectId) + '/file';

export function resolveNovelArt(projectId, novel) {
  return {
    backgrounds: Object.fromEntries((novel.backgrounds || []).map(background => [background.id, background.assetId ? novelAssetUrl(background.assetId) : ''])),
    portraits: Object.fromEntries((novel.characters || []).map(character => [character.id, Object.fromEntries(character.portraits.map(pose => [pose.id, pose.assetId ? novelAssetUrl(pose.assetId) : '']))])),
  };
}
