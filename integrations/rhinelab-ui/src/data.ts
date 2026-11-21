import { normalizeArchiveCover, normalizeCoverAssetId, customCoverUrl, type ArchiveCoverId } from "./archive-cover.ts";
import { archiveWorkspaces, workspaceForKind, workspaceLane } from "./workspace-navigation.ts";

export interface ProjectSummary {
  id: string;
  title: string;
  kind: "video" | "writing" | "science";
  cover: ArchiveCoverId;
  coverAssetId: string;
  coverUrl: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  duration: number | null;
  clipCount: number;
  wordCount: number;
  outputCount: number;
}

export interface ArchiveRecord extends ProjectSummary {
  en: string;
  department: string;
  category: string;
  date: string;
  lead: string;
  clearance: string;
  abstract: string;
  findings: string[];
  source: string;
  status: string;
}

export const records: ArchiveRecord[] = [];
export const categories = ["全部档案", "视频项目", "文案项目", "科普项目"];
export const archiveColumns = archiveWorkspaces.map(workspace => workspace.label);
export let projectsReady = false;
export type ProjectCell = { lane: number; row: number };
let cells: ProjectCell[] = [];
let cellIndices = new Map<string, number>();
function rebuildCells() {
  const rows = new Map<number, number>();
  cells = records.map(record => {
    const lane = workspaceLane(workspaceForKind(record.kind));
    const row = rows.get(lane) ?? 12;
    rows.set(lane, row + 1);
    return { lane, row };
  });
  cellIndices = new Map(cells.map((cell, index) => [`${cell.lane}:${cell.row}`, index]));
}

const boundedNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, 1e9) : 0;
const dateText = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : "";
function normalizeProject(value: unknown): ArchiveRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(p.id) || !["video", "writing", "science"].includes(String(p.kind))) return null;
  const kind = p.kind as ProjectSummary["kind"];
  const description = typeof p.description === "string" ? p.description.slice(0, 1000) : "";
  return {
    id: p.id, title: typeof p.title === "string" && p.title.trim() ? p.title.trim().slice(0, 120) : "未命名项目", kind, description, cover: normalizeArchiveCover(p.cover), coverAssetId: normalizeCoverAssetId(p.coverAssetId), coverUrl: customCoverUrl(p.coverAssetId),
    createdAt: dateText(p.createdAt), updatedAt: dateText(p.updatedAt), duration: typeof p.duration === "number" && Number.isFinite(p.duration) && p.duration >= 0 ? boundedNumber(p.duration) : null, clipCount: boundedNumber(p.clipCount), wordCount: boundedNumber(p.wordCount), outputCount: boundedNumber(p.outputCount),
    en: kind === "video" ? "VIDEO PROJECT" : kind === "science" ? "SCIENCE PROJECT" : "WRITING PROJECT", department: kind === "video" ? "视频剪辑" : kind === "science" ? "科普" : "文案写作", category: kind === "video" ? "视频项目" : kind === "science" ? "科普项目" : "文案项目",
    date: dateText(p.updatedAt), lead: "", clearance: "本地项目", abstract: description, findings: [], source: "", status: "available",
  };
}

/** Only parent-supplied real IDs become cells; renaming keeps their order. */
export function setProjects(input: unknown) {
  const incoming = new Map<string, ArchiveRecord>();
  if (Array.isArray(input)) for (const item of input.slice(0, 10000)) {
    const record = normalizeProject(item);
    if (record && !incoming.has(record.id)) incoming.set(record.id, record);
  }
  const ordered = [...incoming.values()].sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || a.id.localeCompare(b.id));
  records.splice(0, records.length, ...ordered);
  rebuildCells();
  projectsReady = true;
  return records;
}

export function mergeProject(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const index = records.findIndex(record => record.id === value.id);
  if (index < 0) return null;
  const record = normalizeProject({ ...records[index], ...value });
  if (record) { const moved = records[index].kind !== record.kind; records[index] = record; if (moved) rebuildCells(); }
  return record;
}

export function columnFiles(lane: number) { return cells.flatMap((cell, index) => cell.lane === lane ? [index] : []); }
export function fileLocation(index: number) {
  if (!Number.isInteger(index) || !records[index]) return { lane: 2, row: 12, slot: -1 };
  return { ...cells[index], slot: index };
}
export function fileAtSlot(slot: number) { return Number.isInteger(slot) && Boolean(records[slot]) ? slot : -1; }
export function projectAtCell(cell: ProjectCell) { return cellIndices.get(`${cell.lane}:${cell.row}`) ?? -1; }
export function projectCells() { return cells; }
