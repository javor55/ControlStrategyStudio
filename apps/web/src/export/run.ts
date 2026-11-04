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
} from '@csd/export';
import { safeFileName } from '../state/persist';

export interface ExportResult {
  blob: Blob;
  fileName: string;
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
      const plan = planExport(model, config, { date });
      const blob: Blob = await exportPdf(plan, { files, onProgress });
      return { blob, fileName: `${base}.pdf` };
    }
    case 'html': {
      if (!viewerAvailable()) throw new Error('The HTML viewer is not part of this build. Run "npm run build" (it builds the viewer first).');
      const payload = viewerPayload(files, config, { projectName: model.meta.name, revision: config.titleBlock.revision });
      const html = injectViewerData(viewerTemplate, payload, `${model.meta.name} — Control Strategy Studio`);
      return { blob: new Blob([html], { type: 'text/html' }), fileName: `${base}.html` };
    }
    case 'json':
      return { blob: new Blob([projectDataJson(projectData(files, config))], { type: 'application/json' }), fileName: `${base}.json` };
    case 'toml':
      return { blob: new Blob([projectDataToml(projectData(files, config))], { type: 'application/toml' }), fileName: `${base}.toml` };
  }
}
