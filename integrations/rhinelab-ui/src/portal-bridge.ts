export type PortalView = "video" | "writer" | "archive" | "settings";
const allowedViews = new Set<string>(["video", "writer", "archive", "settings"]);
export const embeddedPortal = window.parent !== window;

function sameOriginParent() {
  if (!embeddedPortal) return false;
  try { return window.parent.location.origin === location.origin; }
  catch { return false; }
}

export function portalReady() {
  if (sameOriginParent()) window.parent.postMessage({ type: "guangxuan:ready" }, location.origin);
}

export function openPortalView(view: string | undefined) {
  if (!view || !allowedViews.has(view) || !sameOriginParent()) return false;
  window.parent.postMessage({ type: "guangxuan:open", view }, location.origin);
  return true;
}
