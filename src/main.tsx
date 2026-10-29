import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { App } from './ui/App';

// No StrictMode: the stage owns a WebGL context, which must be created exactly once.
createRoot(document.getElementById('root')!).render(<App />);
