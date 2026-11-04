// Example projects offered in "New project from example". The first entry is
// the small demo opened on first start; the others show more of the format.
import { demoProjectFiles } from '../demo';
import type { Files } from '../types';
import { dosingCipProjectFiles } from './dosingCip';

export interface ExampleProject {
  /** Stable identifier, e.g. for URLs or settings. */
  id: string;
  name: string;
  description: string;
  files: () => Files;
}

export function exampleProjects(): ExampleProject[] {
  return [
    {
      id: 'water-treatment',
      name: 'Water Treatment Brno',
      description: 'Small demo: raw water intake with a level / flow cascade, a pump with dry-run protection and a filling sequence.',
      files: demoProjectFiles,
    },
    {
      id: 'dosing-cip',
      name: 'Dosing & CIP Plant Ostrava',
      description:
        'Showcase: ISA-88 hierarchy with 3 areas and 4 units, company library with composite blocks, cascade, split range, ratio and feed-forward control, interlocks, alarms, batch, start-up and CIP sequences, documentation with tables, charts and images.',
      files: dosingCipProjectFiles,
    },
  ];
}

export { dosingCipProjectFiles };
