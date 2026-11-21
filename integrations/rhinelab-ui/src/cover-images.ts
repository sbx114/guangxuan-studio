import { customCoverUrl, normalizeCoverAssetId } from "./archive-cover.ts";

type Entry = { image: HTMLImageElement; status: "loading" | "ready" | "error" };

/** Image completions belong to their immutable asset ID, never to a reused Image. */
export class ArchiveCoverImages {
  private readonly entries = new Map<string, Entry>();
  private activeId = "";
  private onReady?: () => void;
  private disposed = false;
  private createImage: () => HTMLImageElement;
  private capacity: number;

  constructor(createImage: () => HTMLImageElement = () => new Image(), capacity = 3) {
    this.createImage = createImage;
    this.capacity = Math.max(1, Math.min(8, Math.floor(capacity)));
  }

  select(value: unknown, onReady: () => void) {
    if (this.disposed) return;
    const id = normalizeCoverAssetId(value), wasActive = this.activeId === id;
    this.activeId = id; this.onReady = onReady;
    if (!id) return;
    let entry = this.entries.get(id);
    if (entry?.status === "error" && !wasActive) {
      this.release(entry); this.entries.delete(id); entry = undefined;
    }
    if (entry) { this.entries.delete(id); this.entries.set(id, entry); return; }
    entry = { image: this.createImage(), status: "loading" };
    const current = entry;
    this.entries.set(id, current);
    current.image.onload = () => {
      if (this.disposed || this.entries.get(id) !== current) return;
      current.status = current.image.naturalWidth ? "ready" : "error";
      if (this.activeId === id) this.onReady?.();
    };
    current.image.onerror = () => {
      if (this.disposed || this.entries.get(id) !== current) return;
      current.status = "error";
      if (this.activeId === id) this.onReady?.();
    };
    current.image.src = customCoverUrl(id);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value!;
      this.release(this.entries.get(oldest)!); this.entries.delete(oldest);
    }
  }

  imageFor(value: unknown) {
    const entry = this.entries.get(normalizeCoverAssetId(value));
    return entry?.status === "ready" ? entry.image : undefined;
  }

  private release(entry: Entry) { entry.image.onload = null; entry.image.onerror = null; entry.image.removeAttribute("src"); }
  dispose() {
    this.disposed = true; this.activeId = ""; this.onReady = undefined;
    for (const entry of this.entries.values()) this.release(entry);
    this.entries.clear();
  }
}
