// Runs an export with a given configuration and returns the file to download.
import viewerTemplate from 'virtual:viewer-template';
import type { Files, ProjectModel } from '@csd/core';
import {
  injectViewerData,
  planExport,
  projectData,
  projectDataJson,
  projectDataToml,
  viewerPayload,
  type ExportConfig,
  type HistoryEntry,
} from '@csd/export';
import { store } from '../state/store';
import { history } from '../state/session';
import { safeFileName } from '../state/persist';

export interface ExportResult {
  blob: Blob;
  fileName: string;
}

/** Revision and history from git for title blocks and the history section. */
async function versionInfo(): Promise<{ revision?: string; history: HistoryEntry[]; uncommitted: boolean }> {
  const st = store().getState();
  const log = await history.log().catch(() => []);
  return {
    revision: st.vcs.revision?.replace(/^rev-/, ''),
    uncommitted: st.vcs.changes.length > 0,
    history: log.map((c) => ({
      oid: c.oid,
      date: new Date(c.author.timestamp * 1000).toISOString().slice(0, 10),
      author: c.author.name,
      summary: c.summary,
      message: c.message,
      tags: c.tags,
    })),
  };
}

export function viewerAvailable(): boolean {
  return viewerTemplate.length > 0;
}

export async function runExport(
  config: ExportConfig,
  files: Files,
  model: ProjectModel,
  onProgress?: (done: number, total: number) => void,
): Promise<ExportResult> {
  const date = config.titleBlock.date || new Date().toISOString().slice(0, 10);
  const base = `${safeFileName(model.meta.name)}_${date}`;
  switch (config.format) {
    case 'pdf': {
      const { exportPdf } = await import('@csd/export/pdf');
      const plan = planExport(model, config, { date, ...(await versionInfo()) });
      const blob: Blob = await exportPdf(plan, { files, onProgress });
      return { blob, fileName: `${base}.pdf` };
    }
    case 'html': {
      if (!viewerAvailable()) throw new Error('The HTML viewer is not part of this build. Run "npm run build" (it builds the viewer first).');
      const v = await versionInfo();
      const payload = viewerPayload(files, config, { projectName: model.meta.name, revision: config.titleBlock.revision || v.revision, history: v.history, uncommitted: v.uncommitted });
      const html = injectViewerData(viewerTemplate, payload, `${model.meta.name} — Control Strategy Studio`);
      return { blob: new Blob([html], { type: 'text/html' }), fileName: `${base}.html` };
    }
    case 'json':
      return { blob: new Blob([projectDataJson(projectData(files, config))], { type: 'application/json' }), fileName: `${base}.json` };
    case 'toml':
      return { blob: new Blob([projectDataToml(projectData(files, config))], { type: 'application/toml' }), fileName: `${base}.toml` };
  }
}
