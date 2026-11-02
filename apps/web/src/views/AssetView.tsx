// Preview of a file in assets/ (images). Other binary files show their size.
import { useEffect, useState } from 'react';
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
    <div className="scroll" style={{ flex: 1, padding: 24, display: 'grid', gap: 12, alignContent: 'start', justifyItems: 'center' }}>
      <div style={{ fontFamily: 'var(--f-mono)', fontSize: 12, color: 'var(--ink-2)' }}>
        {file} · {(size / 1024).toFixed(1)} kB
      </div>
      {url ? (
        <img src={url} alt={file ?? ''} style={{ maxWidth: '100%', background: '#fff', border: '1px solid var(--rule)', boxShadow: 'var(--shadow)' }} />
      ) : (
        <div className="empty">No preview for this file type.</div>
      )}
      {url && (
        <div style={{ color: 'var(--ink-3)', fontSize: 12 }}>
          Use in Markdown: <code>![description]({file})</code>
        </div>
      )}
    </div>
  );
}
