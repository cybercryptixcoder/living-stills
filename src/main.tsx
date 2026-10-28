import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/shippori-mincho/latin-500.css';
import '@fontsource/shippori-mincho/latin-600.css';
import './styles/app.css';
import { App } from './ui/App';

// No StrictMode: the stage owns a WebGL context, which must be created exactly once.
createRoot(document.getElementById('root')!).render(<App />);
