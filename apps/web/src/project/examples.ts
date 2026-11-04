// Example projects for Project menu → Open example. They come from
// `exampleProjects()` of @csd/core; until that exists, the demo project is the
// only example.
import * as core from '@csd/core';
import type { Files } from '@csd/core';

export interface ExampleProject {
  id: string;
  name: string;
  description: string;
  files: () => Files;
}

type WithExamples = { exampleProjects?: () => ExampleProject[] };

export function availableExamples(): ExampleProject[] {
  const list = (core as unknown as WithExamples).exampleProjects?.();
  if (list?.length) return list;
  return [{ id: 'demo', name: 'Demo project', description: 'Continuous and sequence strategies of a small tank farm', files: core.demoProjectFiles }];
}

/** Files of the project opened when there is nothing else (first start, project removed). */
export function defaultProjectFiles(): Files {
  return core.demoProjectFiles();
}
