// Read-only viewer of an exported Control Strategy Studio project.
// The editor's HTML export embeds the project files as JSON in #css-export-data;
// without data (npm run dev) the demo project is shown.
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DataContext } from './context';
import { loadViewerData, type ViewerData } from './data';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
let data: ViewerData | undefined;
let error: string | undefined;
try {
  data = loadViewerData();
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
}

root.render(
  data ? (
    <DataContext.Provider value={data}>
      <App />
    </DataContext.Provider>
  ) : (
    <div className="fatal">
      <h1>This export cannot be opened</h1>
      <p>The embedded project data could not be read: {error}</p>
    </div>
  ),
);
