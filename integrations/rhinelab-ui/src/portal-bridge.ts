export type PortalView = "video" | "writer" | "science" | "archive" | "settings" | "tasks" | "restore" | "tools" | "assistant";
const allowedViews = new Set<string>(["video", "writer", "science", "archive", "settings", "tasks", "restore", "tools", "assistant"]);
export const embeddedPortal = window.parent !== window;

function sameOriginParent() {
  if (!embeddedPortal) return false;
  try { return window.parent.location.origin === location.origin; }
  catch { return false; }
}

export function fromPortalParent(event: MessageEvent) {
  return embeddedPortal && event.source === window.parent && event.origin === location.origin && Boolean(event.data && typeof event.data === "object");
}
export function sendPortalMessage(message: Record<string, unknown>) {
  if (!sameOriginParent()) return false;
  window.parent.postMessage(message, location.origin);
  return true;
}

export function portalReady() {
  if (sameOriginParent()) window.parent.postMessage({ type: "guangxuan:ready" }, location.origin);
}

export function openPortalView(view: string | undefined) {
  if (!view || !allowedViews.has(view) || !sameOriginParent()) return false;
  window.parent.postMessage({ type: "guangxuan:open", view }, location.origin);
  return true;
}
