export const SIDEBAR_UI_STORAGE_KEY = "print-partner.sidebar.ui.v1";

export function readSidebarCollapsed(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(SIDEBAR_UI_STORAGE_KEY) === "1";
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SIDEBAR_UI_STORAGE_KEY, collapsed ? "1" : "0");
}
