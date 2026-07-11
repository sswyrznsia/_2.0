import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { MiniPlayer } from './components/mini/MiniPlayer'
import { TaskbarMode, TaskbarToggle } from './components/taskbar/TaskbarPlayer'
import './styles/global.css'

const mini = new URLSearchParams(window.location.search).get('mini') === '1'
const query = new URLSearchParams(window.location.search)
const taskbarMode = query.get('taskbarMode') === '1'
const taskbarToggle = query.get('taskbarToggle') === '1'
if (taskbarMode) document.documentElement.dataset.window = 'taskbar-mode'
if (taskbarToggle) document.documentElement.dataset.window = 'taskbar-toggle'
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    {taskbarMode ? (
      <TaskbarMode />
    ) : taskbarToggle ? (
      <TaskbarToggle />
    ) : mini ? (
      <MiniPlayer />
    ) : (
      <App />
    )}
  </ErrorBoundary>,
)
