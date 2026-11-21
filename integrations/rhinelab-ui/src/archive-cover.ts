export const archiveCovers = [
  { id: "classic", name: "原版档案", background: "#e6e2d9", ink: "#171713", accent: "#878476" },
  { id: "blueprint", name: "蓝图网格", background: "#e1e9e9", ink: "#203b46", accent: "#6e959e" },
  { id: "film", name: "胶片场记", background: "#30332f", ink: "#ece8dc", accent: "#b5bca3" },
  { id: "paper", name: "纸本手稿", background: "#efe4cf", ink: "#544539", accent: "#b08658" },
] as const;
export type ArchiveCoverId = typeof archiveCovers[number]["id"] | "custom";

export function normalizeArchiveCover(value: unknown): ArchiveCoverId {
  return value === "custom" ? "custom" : archiveCovers.find(cover => cover.id === value)?.id ?? "classic";
}
export const normalizeCoverAssetId = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) ? value : "";
export const customCoverUrl = (value: unknown) => { const id = normalizeCoverAssetId(value); return id ? `/api/project-covers/${id}` : ""; };

type CoverRecord = { title: string; kind: string; cover?: unknown };

function fittedText(context: CanvasRenderingContext2D, text: string, maximumWidth: number) {
  const letters = Array.from(text);
  if (context.measureText(text).width <= maximumWidth) return text;
  while (letters.length > 1 && context.measureText(letters.join("") + "…").width > maximumWidth) letters.pop();
  return letters.join("") + "…";
}

/** One local canvas supplies both the actual model texture and the picker preview. */
export function drawArchiveCover(context: CanvasRenderingContext2D, record: CoverRecord | undefined, index: number, selectedCover?: unknown, mark?: CanvasImageSource) {
  const cover = archiveCovers.find(item => item.id === normalizeArchiveCover(selectedCover ?? record?.cover)) ?? archiveCovers[0];
  const title = record?.title || "GUANGXUAN";
  const kind = record?.kind === "video" ? "VIDEO PROJECT" : record?.kind === "science" ? "SCIENCE PROJECT" : record ? "WRITING PROJECT" : "PROJECT ARCHIVE";
  const number = "NO." + String(index + 1).padStart(3, "0");
  const c = context;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.textAlign = "left";
  c.textBaseline = "alphabetic";
  c.fillStyle = cover.background;
  c.fillRect(0, 0, 1024, 440);
  c.strokeStyle = cover.accent;

  if (cover.id === "blueprint") {
    c.globalAlpha = .23;
    c.lineWidth = 1;
    c.beginPath();
    for (let x = 0; x <= 1024; x += 32) { c.moveTo(x, 0); c.lineTo(x, 440); }
    for (let y = 0; y <= 440; y += 32) { c.moveTo(0, y); c.lineTo(1024, y); }
    c.stroke();
    c.globalAlpha = 1;
    c.lineWidth = 3;
    c.strokeRect(14, 14, 996, 410);
    c.beginPath(); c.moveTo(758, 15); c.lineTo(758, 425); c.moveTo(15, 207); c.lineTo(1010, 207); c.stroke();
    c.beginPath(); c.arc(882, 310, 63, 0, Math.PI * 2); c.moveTo(800, 310); c.lineTo(964, 310); c.moveTo(882, 228); c.lineTo(882, 392); c.stroke();
  } else if (cover.id === "film") {
    c.fillStyle = cover.ink;
    for (let x = 15; x < 1010; x += 74) { c.fillRect(x, 13, 35, 13); c.fillRect(x, 414, 35, 13); }
    c.globalAlpha = .4;
    c.fillRect(22, 200, 980, 2);
    c.fillRect(755, 49, 2, 340);
    c.globalAlpha = 1;
    c.lineWidth = 8;
    c.strokeStyle = cover.ink;
    c.strokeRect(800, 252, 173, 103);
    c.beginPath(); c.moveTo(862, 276); c.lineTo(912, 303); c.lineTo(862, 330); c.closePath(); c.fill();
  } else if (cover.id === "paper") {
    c.globalAlpha = .28;
    c.lineWidth = 2;
    c.beginPath();
    for (let y = 213; y < 440; y += 41) { c.moveTo(20, y); c.lineTo(1002, y); }
    c.stroke();
    c.globalAlpha = 1;
    c.fillStyle = cover.accent;
    c.fillRect(14, 14, 996, 7);
    c.fillRect(758, 14, 3, 410);
    c.strokeStyle = cover.accent;
    c.lineWidth = 3;
    c.strokeRect(803, 257, 172, 92);
    c.font = "24px MiSans, sans-serif";
    c.fillText("LOCAL COPY", 820, 310);
  } else {
    c.fillStyle = cover.ink;
    c.fillRect(12, 12, 1000, 6);
    c.fillRect(12, 419, 1000, 3);
    if (mark) c.drawImage(mark, 790, 242, 210, 98);
  }

  c.fillStyle = cover.ink;
  c.font = "bold 81px MiSans, sans-serif";
  c.fillText(fittedText(c, title, 716), 22, 116);
  c.font = "32px MiSans, sans-serif";
  c.fillStyle = cover.accent;
  c.fillText(kind, 25, 174);
  c.fillStyle = cover.ink;
  c.font = "bold 130px MiSans, sans-serif";
  c.fillText(number, 22, 360, 700);
  c.fillRect(782, 48, 221, 39);
  c.fillStyle = cover.background;
  c.font = "24px MiSans, sans-serif";
  c.fillText("G X / A I", 809, 77);
  c.fillStyle = cover.ink;
  c.font = "bold 56px MiSans, sans-serif";
  c.fillText(cover.id === "film" ? "PLAY" : cover.id === "blueprint" ? "GRID" : cover.id === "paper" ? "NOTE" : "INFO", 804, 151);
  c.restore();
}

export function coverPickerMarkup(selected: unknown, selectedAssetId?: unknown) {
  const current = normalizeArchiveCover(selected);
  const assetId = normalizeCoverAssetId(selectedAssetId);
  return `<fieldset class="project-cover-options"><legend>档案封面</legend><input type="hidden" name="coverAssetId" value="${assetId}"><div class="project-cover-grid">${archiveCovers.map(cover => `<label class="project-cover-choice"><input type="radio" name="cover" value="${cover.id}" ${cover.id === current ? "checked" : ""}><span class="project-cover-card"><canvas width="1024" height="440" data-cover-preview="${cover.id}" aria-hidden="true"></canvas><span>${cover.name}</span></span></label>`).join("")}</div><div class="project-cover-custom"><label class="project-cover-choice"><input type="radio" name="cover" value="custom" ${current === "custom" ? "checked" : ""} ${assetId ? "" : "disabled"}><span class="project-cover-card"><img data-custom-cover-preview ${assetId ? `src="${customCoverUrl(assetId)}"` : "hidden"} alt="自定义封面预览"><span>自定义图片</span></span></label><label class="project-cover-upload">上传图片<input type="file" name="coverImage" accept="image/jpeg,image/png,image/webp"></label><small>JPG / PNG / WebP</small></div></fieldset>`;
}

export function readProjectCover(form: ParentNode, fallback?: unknown): ArchiveCoverId {
  return normalizeArchiveCover(form.querySelector<HTMLInputElement>('input[name="cover"]:checked')?.value ?? fallback);
}

export function readProjectCoverAssetId(form: ParentNode) { return normalizeCoverAssetId(form.querySelector<HTMLInputElement>('input[name="coverAssetId"]')?.value); }

export function restoreProjectCover(form: ParentNode, value: unknown, assetId?: unknown) {
  const cover = normalizeArchiveCover(value);
  if (assetId !== undefined) {
    const id = normalizeCoverAssetId(assetId);
    const field = form.querySelector<HTMLInputElement>('input[name="coverAssetId"]'); if (field) field.value = id;
    const custom = form.querySelector<HTMLInputElement>('input[name="cover"][value="custom"]'); if (custom) custom.disabled = !id;
    const image = form.querySelector<HTMLImageElement>('[data-custom-cover-preview]'); if (image) { image.hidden = !id; if (id) image.src = customCoverUrl(id); else image.removeAttribute("src"); }
  }
  form.querySelectorAll<HTMLInputElement>('input[name="cover"]').forEach(input => { input.checked = input.value === cover; });
}

export function paintCoverPicker(form: ParentNode, record: CoverRecord, index: number) {
  for (const canvas of form.querySelectorAll<HTMLCanvasElement>("canvas[data-cover-preview]")) {
    const context = canvas.getContext("2d");
    if (context) drawArchiveCover(context, record, index, canvas.dataset.coverPreview);
  }
}

/** Use the face's aspect ratio for both full-size models and smaller wave textures. */
export function drawArchiveArtwork(context: CanvasRenderingContext2D, selected: unknown, image?: CanvasImageSource & { width: number; height: number }) {
  const c = context, cover = normalizeArchiveCover(selected);
  const { width, height } = c.canvas;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.clearRect(0, 0, width, height);
  if (cover === "custom") {
    // Transparent PNGs and pending images still replace the original printed face.
    c.fillStyle = archiveCovers[0].background;
    c.fillRect(0, 0, width, height);
    if (image && image.width > 0 && image.height > 0) {
      const scale = Math.max(width / image.width, height / image.height);
      c.drawImage(image, (width - image.width * scale) / 2, (height - image.height * scale) / 2, image.width * scale, image.height * scale);
    }
  } else if (cover !== "classic") {
    c.scale(width / 1024, height / 768);
    const palette = archiveCovers.find(item => item.id === cover)!;
    c.strokeStyle = palette.ink; c.fillStyle = palette.ink; c.lineWidth = 2;
    if (cover === "blueprint") {
      c.globalAlpha = .14; c.beginPath();
      for (let x = 20; x < 1024; x += 48) { c.moveTo(x, 20); c.lineTo(x, 748); }
      for (let y = 20; y < 768; y += 48) { c.moveTo(20, y); c.lineTo(1004, y); } c.stroke();
      c.globalAlpha = .45; c.strokeRect(18, 18, 988, 732); c.beginPath(); c.arc(598, 393, 214, 0, Math.PI * 2); c.stroke();
    } else if (cover === "film") {
      c.globalAlpha = .65;
      for (let y = 26; y < 740; y += 58) { c.fillRect(22, y, 22, 30); c.fillRect(980, y, 22, 30); }
      c.lineWidth = 5; c.strokeRect(64, 18, 896, 732); c.globalAlpha = .36;
      c.beginPath(); c.arc(610, 399, 164, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.moveTo(563, 305); c.lineTo(711, 399); c.lineTo(563, 493); c.closePath(); c.stroke();
    } else {
      c.strokeStyle = palette.accent; c.globalAlpha = .52;
      c.strokeRect(19, 18, 986, 732); c.beginPath(); c.moveTo(490, 218); c.lineTo(490, 690); c.stroke();
      c.globalAlpha = .25; c.beginPath();
      for (let y = 250; y < 700; y += 44) { c.moveTo(530, y); c.lineTo(955, y); } c.stroke();
    }
    c.clearRect(100, 52, 242, 113);
  }
  c.restore();
}

export async function uploadProjectCover(file: File, signal: AbortSignal) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("请选择 JPG、PNG 或 WebP 图片。");
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error("请选择20MB以内的图片。");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error("图片无法解码，请换一张图片。"); }
  let blob: Blob;
  try {
    if (bitmap.width * bitmap.height > 64_000_000) throw new Error("图片像素过大，请先缩小到6400万像素以内。");
    signal.throwIfAborted();
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d"); if (!context) throw new Error("无法处理图片，请重试。");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("无法转换图片。")), "image/png"));
  } finally { bitmap.close(); }
  signal.throwIfAborted();
  const response = await fetch("/api/project-covers", { method: "POST", headers: { "Content-Type": "image/png" }, body: blob, signal });
  const result = await response.json();
  if (!response.ok || !normalizeCoverAssetId(result.coverAssetId)) throw new Error(result.error || "封面上传失败，请重试。");
  return normalizeCoverAssetId(result.coverAssetId);
}
