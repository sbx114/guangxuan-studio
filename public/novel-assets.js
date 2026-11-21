import { api, fetchLocal, clone, escapeHtml as h, icon, showModal, toast, uid } from './ui.js';
import { novelAssetUrl } from './visual-novel-art.js';

const endpoint = '/api/novel-library';
export const libraryResources = library => ({ config: { characters: library.characters || [], backgrounds: library.backgrounds || [] }, assetCatalog: { items: library.assets || [] } });
export const loadNovelLibrary = options => api(endpoint, undefined, options);
export const resolveNovelLibrary = (selection, options) => api(endpoint + '/resolve', selection, options);

/** The library is shared by every project; the mounted chooser writes IDs only. */
export function createNovelAssetManager({ onChanged, onSave } = {}) {
  let library = { characters: [], backgrounds: [], assets: [] }, active = null, loading = null, disposed = false, modal = null;
  const uploads = new Set(), controllers = new Set(), removedProjects = new Set();
  const notify = project => { if (!disposed && !removedProjects.has(project.id)) { onChanged?.(project); onSave?.(project); } };
  const chosen = project => project.science.novelConfig;
  async function load(force = false) {
    if (loading) return loading;
    if (library.loaded && !force) return library;
    loading = loadNovelLibrary().then(value => { library = { ...value, loaded: true }; return library; }).finally(() => { loading = null; });
    return loading;
  }
  const preview = (item, kind, label) => item?.assetId ? '<img src="' + h(novelAssetUrl(item.assetId)) + '" alt="' + h(label) + '" class="' + kind + '">' : '<span class="vn-choice-empty">' + h(label) + '</span>';
  function render() {
    if (!active?.host.isConnected || disposed) return;
    const { host, project } = active, config = chosen(project), character = library.characters.find(item => item.id === config.selectedCharacterId), background = library.backgrounds.find(item => item.id === config.selectedBackgroundId);
    const options = (items, selected, noun) => '<option value="">选择一个' + noun + '</option>' + (selected && !items.some(item => item.id === selected) ? '<option value="' + h(selected) + '" selected disabled>原' + noun + '已移除，请重新选择</option>' : '') + items.map(item => '<option value="' + h(item.id) + '" ' + (item.id === selected ? 'selected' : '') + '>' + h(item.name) + '</option>').join('');
    host.innerHTML = '<div class="vn-library-chooser"><div class="vn-section-heading"><div><h3><span class="vn-step-number">02</span> 选择人物和场景</h3><p>选择一位人物和一个场景，公用素材可跨作品使用。</p></div><button class="btn small" data-vn-library-open>' + icon('folder') + '公用素材库</button></div>' + (active.error ? '<p class="notice error" role="alert">' + h(active.error) + '</p>' : '') + '<div class="vn-selection-grid"><label class="vn-selection-card"><span class="vn-selection-preview vn-selection-person">' + preview(character?.portraits?.[0], 'portrait', '人物预览') + '</span><span class="vn-selection-label">讲解人物</span><select data-vn-library-character aria-label="选择讲解人物">' + options(library.characters, config.selectedCharacterId, '人物') + '</select><small>' + (character ? h([character.role, character.tone, character.personality].filter(Boolean).join(' · ') || '可在素材库中编辑人物设定') : '先在公用库导入人物与表情图片') + '</small></label><label class="vn-selection-card"><span class="vn-selection-preview vn-selection-scene">' + preview(background, 'background', '场景预览') + '</span><span class="vn-selection-label">故事场景</span><select data-vn-library-background aria-label="选择故事场景">' + options(library.backgrounds, config.selectedBackgroundId, '场景') + '</select><small>' + (background ? h(background.name) + '' : '先在公用库导入一张场景背景') + '</small></label></div></div>';
    if (active.disabled) host.querySelectorAll('button,select').forEach(field => { field.disabled = true; });
  }
  function libraryList(state) {
    state.listRevision = library.revision; const people = state.tab === 'characters', items = people ? library.characters : library.backgrounds, noun = people ? '人物' : '场景';
    return '<div class="vn-library-toolbar"><p>公用库中的修改会用于所有引用它的作品。人设修改在下次生成时生效。</p><button class="btn primary small" data-library-new>＋ 新建' + noun + '</button></div><div class="vn-library-profile-grid">' + (items.length ? items.map(item => '<article class="vn-library-profile"><div class="vn-library-thumb ' + (people ? 'is-person' : '') + '">' + preview(people ? item.portraits?.[0] : item, people ? 'portrait' : 'background', noun + '图片') + '</div><strong>' + h(item.name) + '</strong><p>' + h(people ? item.role || '未填写人设' : item.fit === 'contain' ? '完整显示' : '铺满画面') + '</p><div class="row wrap"><button class="btn small" data-library-use="' + h(item.id) + '">选用</button><button class="btn small" data-library-edit="' + h(item.id) + '">编辑</button><button class="btn subtle small" data-library-delete="' + h(item.id) + '">移除</button></div></article>').join('') : '<div class="vn-assets-empty"><strong>还没有' + noun + '</strong><p>' + (people ? '新建人物，填写人设、语气和性格，再导入不同表情的立绘。' : '新建场景并导入背景图片。') + '</p></div>') + '</div>';
  }
  function editorMarkup(state) {
    const item = state.draft, people = state.tab === 'characters';
    const imageOptions = (kind, selected) => '<option value="">选择已上传图片</option>' + library.assets.filter(asset => asset.kind === kind).map(asset => '<option value="' + h(asset.id) + '" ' + (asset.id === selected ? 'selected' : '') + '>' + h(asset.name) + '</option>').join('');
    return '<form class="vn-library-editor" data-library-form><button type="button" class="btn subtle small" data-library-back>← 返回素材库</button><h3>' + (people ? '人物设定' : '场景设定') + '</h3><label>' + (people ? '人物姓名' : '场景名称') + '<input data-library-field="name" maxlength="' + (people ? 40 : 60) + '" value="' + h(item.name) + '" required></label>' + (people ? '<div class="vn-persona-fields"><label>人设<textarea data-library-field="role" maxlength="1200" rows="3" placeholder="身份、经历，以及与读者的关系">' + h(item.role) + '</textarea></label><label>语气<textarea data-library-field="tone" maxlength="600" rows="2" placeholder="例如：亲切、简洁，多用生活例子">' + h(item.tone) + '</textarea></label><label>性格<textarea data-library-field="personality" maxlength="600" rows="2" placeholder="例如：耐心、好奇，坦诚说明不确定之处">' + h(item.personality) + '</textarea></label><label class="vn-color-field">对话框主题色<input type="color" data-library-field="color" value="' + h(item.color || '#789e9c') + '"></label></div><div class="row spread wrap"><div><h4>人物表情</h4><p class="tiny muted">支持 PNG / JPEG / WebP，可批量导入。每位人物最多12种表情。</p></div><label class="btn small vn-file-pick">' + icon('upload') + '批量导入表情<input data-library-portraits type="file" accept=".png,.jpg,.jpeg,.webp" multiple hidden></label></div><div class="vn-expression-grid">' + item.portraits.map((pose, index) => '<article data-library-pose="' + index + '"><div class="vn-expression-preview">' + preview(pose, 'portrait', '表情图片') + '</div><input data-library-pose-name maxlength="40" value="' + h(pose.name) + '" aria-label="表情名称" placeholder="表情名称"><select data-library-pose-image aria-label="表情图片">' + imageOptions('portrait', pose.assetId) + '</select><button type="button" class="btn subtle small" data-library-remove-pose="' + index + '">移除此表情</button></article>').join('') + '</div><button type="button" class="btn subtle small" data-library-add-pose ' + (item.portraits.length >= 12 ? 'disabled' : '') + '>＋ 从已上传图片添加表情</button>' : '<div class="vn-background-editor-preview">' + preview(item, 'background', '背景图片') + '</div><div class="form-grid"><label>场景图片<select data-library-field="assetId">' + imageOptions('background', item.assetId) + '</select></label><label>显示方式<select data-library-field="fit"><option value="cover" ' + (item.fit !== 'contain' ? 'selected' : '') + '>铺满画面</option><option value="contain" ' + (item.fit === 'contain' ? 'selected' : '') + '>完整显示</option></select></label></div><label class="btn small vn-file-pick">' + icon('upload') + '导入场景图片<input data-library-background type="file" accept=".png,.jpg,.jpeg,.webp" hidden></label>') + '<div class="vn-library-editor-actions"><button type="submit" class="btn primary">保存到公用素材库</button><span class="tiny muted">图片每张不超过12MB</span></div></form>';
  }
  function paintModal(state) {
    if (!state.host?.isConnected || disposed) return;
    state.host.innerHTML = '<div class="vn-shared-library"><p class="vn-library-intro">本机公用素材库 · 人物、表情和场景集中管理，所有项目均可选择。</p><nav class="vn-library-tabs" aria-label="素材分类"><button class="' + (state.tab === 'characters' ? 'active' : '') + '" data-library-tab="characters">人物</button><button class="' + (state.tab === 'backgrounds' ? 'active' : '') + '" data-library-tab="backgrounds">场景</button></nav>' + (state.error ? '<p class="notice error" role="alert">' + h(state.error) + '</p>' : '') + (state.busy ? '<p class="small muted" role="status"><span class="spinner"></span> 正在保存或导入素材…</p>' : '') + (state.draft ? editorMarkup(state) : libraryList(state)) + (!state.draft ? '<details class="vn-asset-library"><summary>已上传图片 · ' + library.assets.length + ' 张</summary><p class="tiny muted">图片仅在公用库保存一份。被人物、场景使用的图片不能删除。</p><div class="vn-asset-library-grid">' + library.assets.map(asset => '<article><img src="' + h(novelAssetUrl(asset.id)) + '" alt=""><strong>' + h(asset.name) + '</strong><span>' + h(asset.width) + '×' + h(asset.height) + '</span><button class="btn small" data-library-delete-asset="' + h(asset.id) + '">删除未使用图片</button></article>').join('') + '</div></details>' : '') + '</div>';
    if (state.busy) state.host.querySelectorAll('button,input,textarea,select').forEach(field => { field.disabled = true; });
    if (state.conflict) {
      const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'btn small'; reload.dataset.libraryReloadLatest = ''; reload.textContent = '载入最新版本';
      reload.disabled = state.busy;
      state.host.querySelector('[role="alert"]')?.append(reload);
    }
    if (state.localRecovery) {
      const draft = state.localRecovery, fields = [['姓名/名称', draft.name], ['人设', draft.role], ['语气', draft.tone], ['性格', draft.personality], ['对话框颜色', draft.color], ['表情', (draft.portraits || []).map(pose => pose.name).join('、')], ['图片显示', draft.fit ? draft.fit === 'contain' ? '完整显示' : '铺满画面' : '']];
      const box = document.createElement('details'); box.className = 'vn-library-editor'; box.dataset.libraryLocalRecovery = ''; box.open = true;
      box.innerHTML = '<summary>本机未保存的编辑</summary><div class="vn-persona-fields">' + fields.filter(([, value]) => value).map(([label, value]) => '<label>' + h(label) + '<textarea readonly rows="2">' + h(value) + '</textarea></label>').join('') + '</div>';
      state.host.querySelector('.vn-shared-library').append(box);
    }
  }
  function readDraft(state) {
    if (!state.draft) return;
    for (const field of state.host.querySelectorAll('[data-library-field]')) state.draft[field.dataset.libraryField] = field.value;
    for (const row of state.host.querySelectorAll('[data-library-pose]')) { const pose = state.draft.portraits[Number(row.dataset.libraryPose)]; pose.name = row.querySelector('[data-library-pose-name]').value; pose.assetId = row.querySelector('[data-library-pose-image]').value; }
  }
  async function task(state, work) {
    if (state.busy) return;
    readDraft(state); state.error = ''; state.busy = true; paintModal(state);
    try { await work(); }
    catch (error) { if (error.name !== 'AbortError') { state.error = error.code === 'NOVEL_LIBRARY_REVISION_CONFLICT' ? '素材已在其它位置更新，当前输入已保留。可载入最新版本后合并。' : error.message; state.conflict = error.code === 'NOVEL_LIBRARY_REVISION_CONFLICT'; } }
    finally { state.busy = false; if (!disposed) { render(); paintModal(state); } }
  }
  async function upload(file, kind) {
    if (file.size > 12 * 1024 * 1024) throw new Error('每张图片需在12MB以内。');
    const controller = new AbortController(); controllers.add(controller);
    const pending = (async () => { const response = await fetchLocal(endpoint + '/assets/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Asset-Kind': kind }, body: await file.arrayBuffer(), signal: controller.signal }); const result = await response.json(); if (!response.ok) throw new Error(result.error || '图片导入未完成。'); return result.asset; })();
    uploads.add(pending); try { const asset = await pending; library.assets = [...library.assets.filter(item => item.id !== asset.id), asset]; return asset; } finally { controllers.delete(controller); uploads.delete(pending); }
  }
  async function open(project) {
    try { await load(true); } catch (error) { if (active) { active.error = error.message; render(); } return; }
    if (disposed || removedProjects.has(project.id)) return;
    const state = { project, tab: 'characters', draft: null, error: '', busy: false, host: null, close: null };
    const close = showModal({ title: '公用素材库', wide: true, body: '<div data-novel-shared-library></div>', onMount(root, closeModal) {
      state.host = root.querySelector('[data-novel-shared-library]'); state.close = closeModal;
      state.host.addEventListener('input', () => readDraft(state));
      state.host.addEventListener('change', event => { const field = event.target; readDraft(state); if (field.hasAttribute('data-library-portraits')) { const files = [...field.files]; void task(state, async () => { if (!files.length) return; if (state.draft.portraits.length + files.length > 12) throw new Error('每位人物最多12种表情，请减少此次导入的图片。'); for (const file of files) { const asset = await upload(file, 'portrait'); state.draft.portraits.push({ id: 'pose-' + uid().slice(0, 8), name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || '表情', assetId: asset.id }); } await load(true); }); } else if (field.hasAttribute('data-library-background')) { const file = field.files?.[0]; if (file) void task(state, async () => { const asset = await upload(file, 'background'); state.draft.assetId = asset.id; await load(true); }); } else if (field.matches('[data-library-pose-image],[data-library-field="assetId"]')) paintModal(state); });
      state.host.addEventListener('submit', event => { event.preventDefault(); void task(state, async () => { const draft = clone(state.draft), people = state.tab === 'characters'; if (!draft.name?.trim()) throw new Error('请填写' + (people ? '人物姓名。' : '场景名称。')); if (people && (!draft.portraits.length || draft.portraits.some(pose => !pose.name?.trim() || !pose.assetId))) throw new Error('请为人物添加表情名称和对应图片。'); if (!people && !draft.assetId) throw new Error('请导入或选择一张场景图片。'); const result = await api(endpoint + '/' + state.tab, { ...draft, expectedRevision: state.expectedRevision }); await load(true); if (disposed || removedProjects.has(project.id)) return; chosen(project)[people ? 'selectedCharacterId' : 'selectedBackgroundId'] = (people ? result.character : result.background).id; notify(project); state.draft = null; toast('已保存到公用素材库。'); }); });
      state.host.addEventListener('click', event => { const button = event.target.closest('button'); if (!button || state.busy) return; readDraft(state); const people = state.tab === 'characters';
        if (button.dataset.libraryTab) { if (state.conflict && state.draft) state.localRecovery = clone(state.draft); state.tab = button.dataset.libraryTab; state.draft = null; state.error = ''; state.conflict = false; paintModal(state); }
        else if (button.hasAttribute('data-library-new')) { state.expectedRevision = library.revision; state.conflict = false; state.draft = people ? { name: '', role: '', tone: '', personality: '', color: '#789e9c', portraits: [] } : { name: '', assetId: '', fit: 'cover' }; state.error = ''; paintModal(state); }
        else if (button.dataset.libraryEdit) { state.expectedRevision = library.revision; state.conflict = false; state.draft = clone(library[state.tab].find(item => item.id === button.dataset.libraryEdit)); state.error = ''; paintModal(state); }
        else if (button.dataset.libraryUse) { chosen(project)[people ? 'selectedCharacterId' : 'selectedBackgroundId'] = button.dataset.libraryUse; notify(project); render(); state.close(); }
        else if (button.dataset.libraryDelete) void task(state, async () => { await api(endpoint + '/' + state.tab + '/' + encodeURIComponent(button.dataset.libraryDelete) + '?expectedRevision=' + encodeURIComponent(state.listRevision), undefined, { method: 'DELETE' }); await load(true); });
        else if (button.dataset.libraryDeleteAsset) void task(state, async () => { await api(endpoint + '/assets/' + encodeURIComponent(button.dataset.libraryDeleteAsset), undefined, { method: 'DELETE' }); await load(true); });
        else if (button.hasAttribute('data-library-reload-latest')) void task(state, async () => { const local = state.draft ? clone(state.draft) : null; await load(true); if (local) { state.localRecovery = local; state.draft = clone(library[state.tab].find(item => item.id === local.id) || null); } state.expectedRevision = library.revision; state.conflict = false; state.error = local ? '已载入最新版本，本机编辑在下方保留。' : ''; });
        else if (button.hasAttribute('data-library-back')) { if (state.conflict && state.draft) state.localRecovery = clone(state.draft); state.draft = null; state.error = ''; state.conflict = false; paintModal(state); }
        else if (button.hasAttribute('data-library-add-pose') && state.draft.portraits.length < 12) { state.draft.portraits.push({ id: 'pose-' + uid().slice(0, 8), name: '', assetId: '' }); paintModal(state); }
        else if (button.dataset.libraryRemovePose !== undefined) { state.draft.portraits.splice(Number(button.dataset.libraryRemovePose), 1); paintModal(state); }
      }); paintModal(state);
    }, onClose() { if (modal === state) modal = null; render(); } });
    state.close = close; modal = state;
  }
  return {
    mount(host, project, { disabled = false } = {}) { active?.unbind?.(); const lifecycle = new AbortController(); active = { host, project, disabled, unbind: () => lifecycle.abort(), error: '' }; host.addEventListener('change', event => { const field = event.target; if (active?.disabled) return; if (field.hasAttribute('data-vn-library-character')) chosen(project).selectedCharacterId = field.value; else if (field.hasAttribute('data-vn-library-background')) chosen(project).selectedBackgroundId = field.value; else return; notify(project); render(); }, { signal: lifecycle.signal }); host.addEventListener('click', event => { if (!active?.disabled && event.target.closest('[data-vn-library-open]')) void open(project); }, { signal: lifecycle.signal }); render(); void load(true).then(render).catch(error => { if (active?.project === project) { active.error = error.message; render(); } }); },
    async flush(project) { await Promise.all([...uploads]); await load(true); const selected = chosen(project); return { ...libraryResources(library), config: { ...libraryResources(library).config, ...selected } }; },
    resources: () => libraryResources(library),
    async cancelProject(id) { removedProjects.add(id); if (active?.project.id === id) { active.unbind?.(); active = null; } if (modal?.project.id === id) modal.close(); },
    isBusy: () => uploads.size > 0 || Boolean(modal?.busy),
    unmount() { active?.unbind?.(); active = null; },
    dispose() { disposed = true; active?.unbind?.(); active = null; modal?.close(); for (const controller of controllers) controller.abort(); },
  };
}
