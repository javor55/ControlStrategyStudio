import type { Change } from '@csd/vcs';

export interface VcsStatus {
  ready: boolean;
  branch: string;
  head?: string;
  /** Revision tag of the last commit (e.g. "rev-B"), if any. */
  revision?: string;
  /** Working files compared with the last commit. */
  changes: Change[];
  commits: number;
}

export const EMPTY_VCS: VcsStatus = { ready: false, branch: 'main', changes: [], commits: 0 };
