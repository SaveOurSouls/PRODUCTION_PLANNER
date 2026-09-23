import {createRoot} from 'react-dom/client';
import Planner from './Planner';
import './styles.css';
import '@xyflow/react/dist/style.css';
createRoot(document.getElementById('root')!).render(<Planner demo/>);
