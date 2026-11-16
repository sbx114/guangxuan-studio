import { escapeHtml } from "./html";
import type { ArchiveRecord } from "./data";

export function projectDate(value: string) {
  return value ? new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "尚未记录";
}
export function projectDuration(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  const seconds = Math.round(Math.max(0, value));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
export function projectDetailsMarkup(record: ArchiveRecord, number: number) {
  const h = escapeHtml;
  const facts = record.kind === "video"
    ? [["时间线", projectDuration(record.duration)], ["片段", `${record.clipCount} 个`]]
    : [["文本字数", `${record.wordCount} 字`], ["内容草稿", `${record.outputCount} 类`]];
  return `<div class="detail-kicker"><span>PROJECT ${String(number).padStart(3, "0")}</span><span>${record.kind === "video" ? "视频项目" : "文案项目"}</span></div>
    <h2 class="project-heading" title="${h(record.title)}">${h(record.title)}</h2>
    <div class="detail-rule"></div>
    <dl class="metadata project-metadata"><div><dt>创建时间</dt><dd>${h(projectDate(record.createdAt))}</dd></div><div><dt>更新时间</dt><dd>${h(projectDate(record.updatedAt))}</dd></div>${facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>
    <form id="project-details-form" class="project-details-form"><label>项目名称<input id="project-name" name="title" maxlength="120" value="${h(record.title)}" required autocomplete="off"></label><label>简介<textarea id="project-description" name="description" maxlength="1000" rows="3" placeholder="描述这个项目的内容或用途">${h(record.description)}</textarea></label>
      <div class="detail-actions"><button type="submit" id="save-project-details" class="project-save">保存信息</button><button type="button" id="edit-project" class="solid-button portal-launch" data-action="edit-project">进入编辑<span>→</span></button></div><p id="project-save-status" class="project-save-status" role="status"></p>
    </form><div class="project-record-id">ID ${h(record.id)}</div>`;
}
