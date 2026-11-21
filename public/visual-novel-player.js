/** Deliberately self-contained: the exported reader runs with no network. */
export function createNovelPlayer(host, novel, options = {}) {
  const h = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const scene = novel.scenes[0], character = novel.characters[0], background = novel.backgrounds[0], units = new Map(novel.documentSnapshot.units.map(unit => [unit.id, unit]));
  const art = options.art || { backgrounds: {}, portraits: {} }, signature = JSON.stringify([novel.id, scene.lines]);
  const storageKey = 'gx-novel:' + (options.storageKey || novel.id), lifecycle = new AbortController();
  const initial = () => ({ sceneId: scene.id, lineIndex: 0, phase: 'dialogue', history: [], choices: [], answers: Object.create(null), pendingAnswer: null, completed: false });
  let state = initial(), revealed = false, auto = false, timer = null, autoTimer = null, overlay = null, overlayFocus = null, disposed = false, storageFailed = false;
  host.innerHTML = '<section class="vn-player" tabindex="0" aria-label="视觉小说阅读器"><div class="vn-backdrop"></div><div class="vn-vignette"></div><div class="vn-player-top"><div><span class="vn-player-kicker">SCIENCE · 视觉小说</span><strong>' + h(novel.title) + '</strong></div><div class="vn-top-actions"><button data-vn-restart>重读</button><button data-vn-fullscreen aria-label="切换全屏">全屏</button>' + (options.onClose ? '<button data-vn-close aria-label="关闭阅读器">关闭</button>' : '') + '</div></div><div class="vn-actors" aria-hidden="true"></div><div class="vn-card-peek" hidden><button data-vn-card>知识卡</button></div><div class="vn-dialogue"><div class="vn-nameplate" data-vn-speaker></div><div class="vn-line-meta"><span data-vn-line-kind></span><button data-vn-source hidden>查看原文依据</button></div><button class="vn-speech" data-vn-advance aria-label="显示完整对话或继续"><span data-vn-text></span><span class="vn-next-marker" aria-hidden="true">▾</span></button><div class="vn-choice-list" data-vn-choices hidden></div><div class="vn-player-controls"><span class="vn-position" data-vn-position></span><div><button data-vn-history>历史</button><button data-vn-cards>知识卡</button><button data-vn-auto aria-pressed="false">自动</button><button data-vn-save>存档</button><button data-vn-load>读档</button><button data-vn-next>继续 ▸</button></div></div></div><div class="vn-player-notice" role="status" hidden></div><div class="vn-overlay" hidden></div></section>';
  const root = host.querySelector('.vn-player'), line = () => scene.lines[state.lineIndex], question = () => line().question;
  function notice(message) { const box = root.querySelector('.vn-player-notice'); box.textContent = message; box.hidden = !message; }
  function store(suffix = 'auto') { try { localStorage.setItem(storageKey + ':' + suffix, JSON.stringify({ version: 2, signature, title: novel.title, at: new Date().toISOString(), state: { ...state, history: state.history.slice(-1000) } })); if (storageFailed) notice(''); storageFailed = false; return true; } catch { storageFailed = true; notice('当前浏览器无法保存进度；阅读仍可继续。'); return false; } }
  function getSave(suffix) { try { const saved = JSON.parse(localStorage.getItem(storageKey + ':' + suffix) || 'null'); return saved?.version === 2 ? saved : null; } catch { return null; } }
  function restore(saved) {
    if (!saved || saved.signature !== signature || saved.state?.sceneId !== scene.id || !Number.isInteger(saved.state.lineIndex) || saved.state.lineIndex < 0 || saved.state.lineIndex >= scene.lines.length) { notice('存档不属于当前讲解版本，请从开头阅读。'); return false; }
    const answers = Object.create(null);
    for (const value of scene.lines) if (value.question) { const savedChoice = saved.state.answers?.[value.question.id]; if (value.question.choices.some(choice => choice.id === savedChoice)) answers[value.question.id] = savedChoice; }
    const pending = saved.state.pendingAnswer, currentQuestion = scene.lines[saved.state.lineIndex].question;
    state = { sceneId: scene.id, lineIndex: saved.state.lineIndex, completed: saved.state.completed === true, history: Array.isArray(saved.state.history) ? saved.state.history.filter(item => item && typeof item.text === 'string').slice(-1000).map(item => ({ speaker: String(item.speaker || ''), text: item.text.slice(0, 2000), lineId: String(item.lineId || '') })) : [], choices: Array.isArray(saved.state.choices) ? saved.state.choices.filter(item => typeof item === 'string').slice(-100) : [], answers, pendingAnswer: pending && currentQuestion?.id === pending.questionId && answers[pending.questionId] === pending.choiceId ? { questionId: pending.questionId, choiceId: pending.choiceId } : null };
    state.phase = state.pendingAnswer ? 'feedback' : saved.state.phase === 'question' && currentQuestion && !Object.hasOwn(answers, currentQuestion.id) && !state.completed ? 'question' : 'dialogue';
    closeOverlay(false); render(); if (state.pendingAnswer) showAnswer(); else focusPhase(); return true;
  }
  function stopTimers() { clearInterval(timer); clearTimeout(autoTimer); timer = null; autoTimer = null; }
  const choosing = () => Boolean(state.phase === 'question' && revealed && question() && !Object.hasOwn(state.answers, question().id) && !state.completed);
  function scheduleAuto() { clearTimeout(autoTimer); if (auto && revealed && !overlay && !state.pendingAnswer && !choosing() && !state.completed && !document.hidden) autoTimer = setTimeout(advance, Math.min(9000, Math.max(2200, line().text.length * 55))); }
  function showAll() { clearInterval(timer); timer = null; root.querySelector('[data-vn-text]').textContent = line().text; revealed = true; paintChoices(); scheduleAuto(); }
  function remember() { const value = line(), speaker = value.speakerId ? character.name : '旁白'; if (!state.history.some(item => item.lineId === value.id)) state.history.push({ lineId: value.id, speaker, text: value.text }); state.history = state.history.slice(-1000); }
  function paintChoices() {
    const box = root.querySelector('[data-vn-choices]'), show = choosing(), quiz = question(), feedback = Boolean(state.pendingAnswer), separate = state.phase === 'question' || feedback;
    root.dataset.vnPhase = feedback ? 'feedback' : show ? 'question' : 'dialogue'; box.hidden = !show;
    box.innerHTML = show ? '<span class="vn-choice-caption">想一想，再选择</span><p class="vn-question-prompt" data-vn-question-heading tabindex="-1">' + h(quiz.prompt) + '</p><button class="vn-question-source" data-vn-question-source>查看题目依据</button>' + quiz.choices.map((choice, index) => '<button data-vn-choice="' + index + '"><span>' + String.fromCharCode(65 + index) + '</span>' + h(choice.text) + '</button>').join('') : '';
    for (const selector of ['.vn-nameplate', '.vn-line-meta', '.vn-speech']) root.querySelector(selector).hidden = separate;
    root.querySelector('.vn-dialogue').hidden = feedback;
    root.querySelector('.vn-card-peek').hidden = separate || !line().card;
    const next = root.querySelector('[data-vn-next]'); next.hidden = separate; next.disabled = separate || state.completed; next.textContent = quiz && !Object.hasOwn(state.answers, quiz.id) ? '开始答题 ▸' : '继续 ▸';
    root.querySelector('.vn-next-marker').hidden = !revealed || show || state.completed;
    root.querySelector('.vn-dialogue').classList.toggle('is-question', show);
  }
  function focusPhase() { const target = choosing() ? root.querySelector('[data-vn-question-heading]') : root.querySelector('[data-vn-advance]'); if (!overlay && target && !target.hidden) target.focus({ preventScroll: true }); }
  function beginQuestion() { stopTimers(); state.phase = 'question'; paintChoices(); root.querySelector('.vn-dialogue').scrollTop = 0; store(); focusPhase(); }
  function render() {
    if (disposed) return; stopTimers(); revealed = false;
    const value = line(), image = art.backgrounds?.[background.id] || '', poseId = value.poseId || scene.actors[0].poseId, portrait = art.portraits?.[character.id]?.[poseId];
    const backdrop = root.querySelector('.vn-backdrop'); backdrop.style.backgroundImage = image ? 'url("' + image.replace(/["\\\n\r]/g, '') + '")' : ''; backdrop.style.backgroundSize = background.fit || 'cover';
    root.querySelector('[data-vn-speaker]').textContent = value.speakerId ? character.name : '旁白'; root.style.setProperty('--vn-character', character.color || '#c6a989');
    root.querySelector('[data-vn-line-kind]').textContent = value.kind === 'knowledge' ? '知识讲解' : '对话';
    root.querySelector('[data-vn-source]').hidden = !value.citations?.length;
    root.querySelector('[data-vn-position]').textContent = '对话 ' + (state.lineIndex + 1) + ' / ' + scene.lines.length;
    root.querySelector('.vn-card-peek').hidden = !value.card;
    root.querySelector('[data-vn-cards]').disabled = !scene.lines.slice(0, state.lineIndex + 1).some(item => item.card);
    root.querySelector('.vn-actors').innerHTML = portrait ? '<img draggable="false" class="vn-actor vn-actor-center' + (value.speakerId ? ' is-speaking' : '') + '" src="' + h(portrait) + '" alt="">' : '';
    let artStatus = root.querySelector('.vn-art-status'); if (!artStatus) { artStatus = document.createElement('p'); artStatus.className = 'vn-art-status'; artStatus.setAttribute('role', 'status'); root.querySelector('.vn-actors').after(artStatus); }
    artStatus.textContent = !image || !portrait ? '公用素材图片未能显示，请返回素材库检查。' : ''; artStatus.hidden = Boolean(image && portrait);
    root.querySelector('[data-vn-text]').textContent = ''; paintChoices(); remember(); store();
    const letters = Array.from(value.text), output = root.querySelector('[data-vn-text]'); let position = 0;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (options.instantText || reduced || state.completed || state.phase === 'question' || state.pendingAnswer) showAll();
    else timer = setInterval(() => { position++; output.textContent = letters.slice(0, position).join(''); if (position >= letters.length) showAll(); }, 22);
    if (state.completed) notice('阅读完成。可以回看知识卡和原文依据，或点击“重读”。');
    options.onProgress?.({ sceneId: scene.id, lineIndex: state.lineIndex, completed: state.completed, answers: { ...state.answers } });
  }
  function nextLine() { state.phase = 'dialogue'; if (state.lineIndex < scene.lines.length - 1) { state.lineIndex++; notice(''); render(); } else { state.completed = true; auto = false; root.querySelector('[data-vn-auto]').setAttribute('aria-pressed', 'false'); showAll(); paintChoices(); store(); notice('阅读完成。可以回看知识卡和原文依据，或点击“重读”。'); options.onProgress?.({ sceneId: scene.id, lineIndex: state.lineIndex, completed: true, answers: { ...state.answers } }); } }
  function advance() { if (disposed || overlay || state.completed || state.pendingAnswer) return; if (!revealed) return showAll(); if (choosing()) return; if (question() && !Object.hasOwn(state.answers, question().id)) return beginQuestion(); nextLine(); }
  function citationMarkup(citations) { return (citations || []).map(citation => { const unit = units.get(citation.unitId); return '<article class="vn-evidence"><strong>' + h(unit?.label || citation.unitId) + '</strong><blockquote>' + h(citation.quote) + '</blockquote><details><summary>展开该页段原文</summary><p>' + h(unit?.text || '') + '</p></details></article>'; }).join(''); }
  function showOverlay(title, body) { stopTimers(); if (!revealed) showAll(); clearTimeout(autoTimer); overlayFocus = document.activeElement; overlay = title; const box = root.querySelector('.vn-overlay'); for (const child of root.children) if (child !== box) child.inert = true; box.hidden = false; box.innerHTML = '<section class="vn-overlay-panel" role="dialog" aria-modal="true" aria-label="' + h(title) + '"><header><h3>' + h(title) + '</h3><button data-vn-overlay-close aria-label="关闭面板">×</button></header><div class="vn-overlay-body">' + body + '</div></section>'; box.querySelector('[data-vn-overlay-close]').focus(); }
  function closeOverlay(focus = true) { const box = root.querySelector('.vn-overlay'); box.hidden = true; box.innerHTML = ''; for (const child of root.children) if (child !== box) child.inert = false; overlay = null; if (focus) { if (overlayFocus?.isConnected && root.contains(overlayFocus) && !overlayFocus.closest('[hidden],[inert]') && overlayFocus.getClientRects().length) overlayFocus.focus({ preventScroll: true }); else focusPhase(); } overlayFocus = null; scheduleAuto(); }
  function focusFeedback() { const heading = root.querySelector('[data-vn-feedback-heading]'); if (heading) { heading.focus({ preventScroll: true }); root.querySelector('.vn-overlay-panel').scrollTop = 0; } }
  function showAnswer() { const quiz = question(), selected = quiz?.choices.find(choice => choice.id === state.pendingAnswer?.choiceId); if (!selected) return; showOverlay(selected.correct ? '理解正确' : '再看清这个条件', '<p class="vn-feedback">' + h(selected.feedback) + '</p>' + citationMarkup(selected.citations) + '<button class="vn-overlay-primary" data-vn-choice-continue>继续讲解 ▸</button>'); root.querySelector('[data-vn-overlay-close]').hidden = true; const heading = root.querySelector('.vn-overlay-panel h3'); heading.setAttribute('data-vn-feedback-heading', ''); heading.tabIndex = -1; focusFeedback(); }
  function select(index) { const quiz = question(), choice = quiz?.choices[index]; if (!choosing() || !choice || Object.hasOwn(state.answers, quiz.id) || overlay || state.completed) return; state.answers[quiz.id] = choice.id; state.choices.push(quiz.id + ':' + choice.id); state.pendingAnswer = { questionId: quiz.id, choiceId: choice.id }; state.phase = 'feedback'; store(); paintChoices(); showAnswer(); }
  function finishAnswer() { if (!state.pendingAnswer) return; state.pendingAnswer = null; state.phase = 'dialogue'; closeOverlay(false); store(); nextLine(); focusPhase(); }
  root.addEventListener('click', event => {
    const target = event.target.closest('button'); if (!target) return;
    if (target.hasAttribute('data-vn-advance') || target.hasAttribute('data-vn-next')) advance();
    else if (target.dataset.vnChoice !== undefined) select(Number(target.dataset.vnChoice));
    else if (target.hasAttribute('data-vn-auto')) { auto = !auto; target.setAttribute('aria-pressed', String(auto)); scheduleAuto(); }
    else if (target.hasAttribute('data-vn-overlay-close')) { if (state.pendingAnswer) finishAnswer(); else closeOverlay(); }
    else if (target.hasAttribute('data-vn-choice-continue')) finishAnswer();
    else if (target.hasAttribute('data-vn-source')) showOverlay('原文依据 · ' + novel.documentSnapshot.title, citationMarkup(line().citations));
    else if (target.hasAttribute('data-vn-question-source')) showOverlay('问题依据', citationMarkup(question().citations));
    else if (target.hasAttribute('data-vn-card')) { const card = line().card; showOverlay(card.title, '<p class="vn-card-text">' + h(card.text) + '</p>' + citationMarkup(card.citations)); }
    else if (target.hasAttribute('data-vn-cards')) showOverlay('已读知识卡', scene.lines.slice(0, state.lineIndex + 1).filter(value => value.card).map(value => '<article class="vn-collected-card"><h4>' + h(value.card.title) + '</h4><p>' + h(value.card.text) + '</p>' + citationMarkup(value.card.citations) + '</article>').join(''));
    else if (target.hasAttribute('data-vn-history')) showOverlay('对话历史', state.history.map(item => '<article class="vn-history-line"><strong>' + h(item.speaker) + '</strong><p>' + h(item.text) + '</p></article>').join(''));
    else if (target.hasAttribute('data-vn-restart')) showOverlay('从头阅读', '<p>从第一句重新阅读，并重新回答互动问题。手动存档仍可读取。</p><button class="vn-overlay-primary" data-vn-confirm-restart>从头开始</button>');
    else if (target.hasAttribute('data-vn-confirm-restart')) { state = initial(); closeOverlay(); render(); }
    else if (target.hasAttribute('data-vn-save') || target.hasAttribute('data-vn-load')) { const saving = target.hasAttribute('data-vn-save'); showOverlay(saving ? '保存进度' : '读取进度', '<p class="vn-overlay-hint">存档包含阅读位置和答题状态，保存在当前浏览器。离线文件使用独立进度。</p>' + ['auto', '1', '2', '3'].filter(slot => !saving || slot !== 'auto').map(slot => { const value = getSave(slot); return '<button class="vn-slot" data-vn-slot="' + slot + '" data-vn-slot-mode="' + (saving ? 'save' : 'load') + '" ' + (!saving && !value ? 'disabled' : '') + '><span>' + (slot === 'auto' ? '自动' : '存档 ' + slot) + '</span><strong>' + (value ? '对话 ' + (value.state.lineIndex + 1) + (value.state.completed ? ' · 已读完' : '') : '空存档') + '</strong><small>' + (value?.at ? h(new Date(value.at).toLocaleString('zh-CN')) : '') + '</small></button>'; }).join('')); }
    else if (target.dataset.vnSlot !== undefined) { if (target.dataset.vnSlotMode === 'save') { if (store(target.dataset.vnSlot)) { closeOverlay(); notice('进度已保存。'); } } else restore(getSave(target.dataset.vnSlot)); }
    else if (target.hasAttribute('data-vn-fullscreen')) { if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); else root.requestFullscreen?.().catch(() => notice('当前窗口不支持全屏，可以继续阅读。')); }
    else if (target.hasAttribute('data-vn-close')) options.onClose?.();
  }, { signal: lifecycle.signal });
  root.addEventListener('keydown', event => {
    if (event.target.closest('input,textarea,select')) return;
    if (event.repeat && (event.code === 'Space' || event.key === 'Enter' || /^[1-6]$/.test(event.key))) { event.preventDefault(); return; }
    if (event.key === 'Escape' && overlay) { event.preventDefault(); if (!state.pendingAnswer) closeOverlay(); return; }
    if (overlay) { if (event.key === 'Tab') { const buttons = [...root.querySelectorAll('.vn-overlay button, .vn-overlay summary')].filter(button => !button.disabled && button.getClientRects().length), index = buttons.indexOf(document.activeElement); if (!buttons.length) return; if (event.shiftKey && index <= 0) { event.preventDefault(); buttons.at(-1).focus(); } else if (!event.shiftKey && index === buttons.length - 1) { event.preventDefault(); buttons[0].focus(); } } return; }
    if (choosing() && /^[1-6]$/.test(event.key)) { event.preventDefault(); select(Number(event.key) - 1); return; }
    if ((event.code === 'Space' && (event.target === root || event.target.closest('[data-vn-advance]'))) || (event.key === 'Enter' && event.target === root)) { event.preventDefault(); advance(); }
  }, { signal: lifecycle.signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(autoTimer); store(); } else scheduleAuto(); }, { signal: lifecycle.signal });
  const previous = getSave('auto'); if (previous && previous.signature === signature && restore(previous)) notice('已继续上次阅读进度。'); else { render(); if (previous) notice('讲解内容已更新，已从开头开始。'); }
  if (state.pendingAnswer) focusFeedback(); else if (choosing()) focusPhase(); else root.focus({ preventScroll: true });
  return { getState: () => JSON.parse(JSON.stringify(state)), advance, reveal: showAll, select, dispose() { if (disposed) return; store(); disposed = true; stopTimers(); lifecycle.abort(); host.replaceChildren(); }, root };
}
