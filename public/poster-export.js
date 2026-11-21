/** Measure every field before allocating the final PNG canvas. */
export function layoutPoster(ctx, output, { maxHeight = 16384 } = {}) {
  const width = 1080, left = 84, textWidth = 900, lines = [], rules = [];
  let y = 120;
  const add = (value, size, color, weight = '400') => {
    const text = String(value ?? '');
    if (!text) return;
    const font = `${weight} ${size}px "Microsoft YaHei", sans-serif`, lineHeight = size * 1.55;
    ctx.font = font;
    for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
      let line = '';
      const flush = () => { lines.push({ text: line, x: left, y, font, color, size }); y += lineHeight; line = ''; };
      for (const character of Array.from(paragraph)) {
        if (line && ctx.measureText(line + character).width > textWidth) flush();
        line += character;
      }
      flush();
    }
  };
  add(output.eyebrow, 23, '#696f5e');
  rules.push(Math.max(162, y + 6));
  y = Math.max(275, y + 75);
  add(output.title, 70, '#22271e', '600');
  y += 35;
  add(output.subtitle, 30, '#626957');
  const accentY = y + 10;
  y += 74;
  for (const item of Array.isArray(output.highlights) ? output.highlights : []) { add(item, 27, '#46503e'); y += 14; }
  y = Math.max(y + 40, 1080);
  rules.push(y - 28);
  for (const item of Array.isArray(output.details) ? output.details : []) {
    y += 15;
    add([item.label, item.value].filter(value => value !== undefined && value !== null && String(value) !== '').join('  '), 22, '#505946');
  }
  y = Math.max(1350, y + 70);
  add(output.footer, 17, '#7a806e');
  const height = Math.max(1440, Math.ceil(y + 60));
  if (height > maxHeight) throw new Error('稿件内容过长，完整PNG需要超过图片高度上限。请缩短内容，或使用Word、TXT、Markdown导出；尚未生成图片。');
  return { width, height, lines, rules, accentY };
}

export async function exportPosterImage(output, { document, saveFile, safeName }) {
  if (!output) throw new Error('当前没有可导出的海报稿件。');
  await document.fonts?.ready;
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前窗口无法创建海报画布。');
  const layout = layoutPoster(ctx, output);
  canvas.width = layout.width; canvas.height = layout.height;
  ctx.fillStyle = '#e8e5e0'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#c5c8b8'; ctx.lineWidth = 3; ctx.strokeRect(36, 36, canvas.width - 72, canvas.height - 72);
  ctx.save(); ctx.translate(900, 510); ctx.strokeStyle = '#9ca28c30'; ctx.lineWidth = 56;
  ctx.beginPath(); ctx.arc(0, 0, 240, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 16;
  ctx.beginPath(); ctx.arc(0, 0, 295, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  ctx.strokeStyle = '#b7bdab'; ctx.lineWidth = 2;
  for (const y of layout.rules) { ctx.beginPath(); ctx.moveTo(84, y); ctx.lineTo(996, y); ctx.stroke(); }
  ctx.fillStyle = '#9b8056'; ctx.fillRect(84, layout.accentY, 100, 8);
  for (const line of layout.lines) { ctx.font = line.font; ctx.fillStyle = line.color; ctx.fillText(line.text, line.x, line.y); }
  const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('海报图片生成失败，尚未保存，请重试或改用文字导出。')), 'image/png'));
  return saveFile(`${safeName(output.title)}-海报.png`, blob);
}
