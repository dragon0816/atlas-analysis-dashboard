import { parseDashboardDocument } from "./documents";
import { loadDashboard, persistDashboard } from "./persistence";
import type { DashboardDocument } from "./types";

/** The server's document limit; a larger file is refused before it is read. */
export const MAX_DASHBOARD_FILE_BYTES = 2_000_000;
const UNSAFE_NAME = /[\\/:%?*<>|"\u0000-\u001f]/g;

export function parseDashboardFile(text: string, installedApplications: string[]): DashboardDocument {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("This file is not valid JSON."); }
  const document = parseDashboardDocument(raw);
  if (!installedApplications.includes(document.applicationId)) throw new Error(`Application “${document.applicationId}” is not installed.`);
  return document;
}
export function dashboardFileText(document: DashboardDocument) { return `${JSON.stringify(document, null, 2)}\n`; }
export function exportFileName(name: string) { return `${name.replace(UNSAFE_NAME, "-").trim() || "dashboard"}.json`; }
/** A starting name only: the person can edit it, and the server has the last word. */
export function importNameFor(fileName: string, document: DashboardDocument) {
  const stem = fileName.replace(/\.json$/i, "").replace(UNSAFE_NAME, "-").replace(/^[.\s]+|[.\s]+$/g, "");
  return stem || document.title.replace(UNSAFE_NAME, "-").trim();
}
/** Creating never overwrites (If-None-Match: *); only an explicit replace sends If-Match. */
export async function storeImportedDashboard(name: string, document: DashboardDocument, replace: boolean) {
  if (!replace) return persistDashboard(name, document, null, true);
  const { revision } = await loadDashboard(name);
  return persistDashboard(name, document, revision, false);
}
export function downloadDashboard(document: DashboardDocument, name: string) {
  const url = URL.createObjectURL(new Blob([dashboardFileText(document)], { type: "application/json" }));
  const link = window.document.createElement("a");
  link.href = url; link.download = exportFileName(name);
  window.document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
