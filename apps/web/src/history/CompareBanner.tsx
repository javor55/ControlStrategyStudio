// Banner above every canvas (strategy, sequence) while the working copy is
// compared with an older version. One component, one legend, one summary format
// (history/format.ts) and one exit label.
import type { SequenceDiff, StrategyDiff } from '@csd/core';
import { DIFF_COLORS } from '@csd/render';
import { compareState, stopCompare, useCompare } from './compare';
import { summarizeSequence, summarizeStrategy } from './format';
import './history.css';

const SWATCH: Record<keyof typeof DIFF_COLORS, string> = {
  added: `var(--diff-add, ${DIFF_COLORS.added})`,
  changed: `var(--diff-chg, ${DIFF_COLORS.changed})`,
  removed: `var(--diff-del, ${DIFF_COLORS.removed})`,
};

function Swatch({ kind, label }: { kind: keyof typeof DIFF_COLORS; label: string }) {
  return (
    <span className="hx-legend">
      <span className="hx-swatch" style={{ background: SWATCH[kind] }} aria-hidden="true" />
      {label}
    </span>
  );
}

export type CompareDiff = { kind: 'strategy'; diff?: StrategyDiff } | { kind: 'sequence'; diff?: SequenceDiff };

function summary(d: CompareDiff): string {
  if (d.kind === 'strategy') return d.diff ? summarizeStrategy(d.diff) : 'no changes in this strategy';
  return !d.diff || d.diff.kind === 'unchanged' ? 'no changes in this sequence' : summarizeSequence(d.diff);
}

export function CompareBanner(props: CompareDiff) {
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
          <span className="hx-banner-sum">{summary(props)}</span>
          <Swatch kind="added" label="added" />
          <Swatch kind="changed" label="changed" />
          <Swatch kind="removed" label="removed" />
        </>
      )}
      <span className="spacer" />
      <button className="btn small" title="Leave comparison mode (Esc in this banner)" onClick={() => compareState().target && stopCompare()} onKeyDown={(e) => e.key === 'Escape' && stopCompare()}>
        Exit comparison
      </button>
    </div>
  );
}
