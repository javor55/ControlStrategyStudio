// Preview of a file in assets/ (images). Other binary files show their size.
import { useEffect, useState } from 'react';
import { copyAssetReference } from '../project/actions';
import { useEditor } from '../state/store';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export function AssetView() {
  const file = useEditor((s) => s.activeFile);
  const content = useEditor((s) => (s.activeFile ? s.files[s.activeFile] : undefined));
  const [url, setUrl] = useState<string>();
  const ext = file?.split('.').pop()?.toLowerCase() ?? '';
  const mime = MIME[ext];

  useEffect(() => {
    if (!mime || content === undefined) return setUrl(undefined);
    const blob = new Blob([content as BlobPart], { type: mime });
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [content, mime]);

  const size = content === undefined ? 0 : typeof content === 'string' ? new Blob([content]).size : content.byteLength;
  return (
    <div className="scroll asset-view">
      <div className="asset-meta mono">
        {file} · {(size / 1024).toFixed(1)} kB
      </div>
      {url ? <img className="asset-img" src={url} alt={file ?? ''} /> : <div className="empty">No preview for this file type.</div>}
      {url && file && (
        <div className="asset-use">
          Use in Markdown: <code>![description]({file})</code>{' '}
          <button type="button" className="btn small" onClick={() => copyAssetReference(file)}>
            Copy
          </button>
        </div>
      )}
    </div>
  );
}
