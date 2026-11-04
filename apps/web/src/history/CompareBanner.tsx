// Banner above the canvas while the working copy is compared with an older version.
import type { StrategyDiff } from '@csd/core';
import { DIFF_COLORS } from '@csd/render';
import { compareState, stopCompare, useCompare } from './compare';
import { summarizeStrategy } from './format';
import './history.css';

function Swatch({ kind, label }: { kind: keyof typeof DIFF_COLORS; label: string }) {
  return (
    <span className="hx-legend">
      <span className="hx-swatch" style={{ background: DIFF_COLORS[kind] }} aria-hidden="true" />
      {label}
    </span>
  );
}

export function CompareBanner({ diff }: { diff?: StrategyDiff }) {
  const { target, loading } = useCompare();
  if (!target) return null;
  return (
    <div className="hx-banner" role="status" data-testid="compare-banner">
      <span>
        Comparing with <b>{target.label}</b>
        {loading ? ' — loading…' : ' —'}
      </span>
      {!loading && (
        <>
          <Swatch kind="added" label="added" />
          <Swatch kind="changed" label="changed" />
          <Swatch kind="removed" label="removed" />
          <span className="hx-banner-sum">· {diff ? summarizeStrategy(diff) : 'no changes in this strategy'}</span>
        </>
      )}
      <span className="spacer" />
      <button className="btn small" title="Leave comparison mode (Esc in the banner)" onClick={() => compareState().target && stopCompare()} onKeyDown={(e) => e.key === 'Escape' && stopCompare()}>
        Exit
      </button>
    </div>
  );
}
