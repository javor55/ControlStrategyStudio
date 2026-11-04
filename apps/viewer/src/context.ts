import { createContext, useContext } from 'react';
import type { ViewerData } from './data';

export const DataContext = createContext<ViewerData | null>(null);

export function useData(): ViewerData {
  const d = useContext(DataContext);
  if (!d) throw new Error('No viewer data');
  return d;
}
