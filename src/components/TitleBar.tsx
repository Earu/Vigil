import { useEffect, useState } from 'react';
import './TitleBar.css';

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    // Only run in electron environment
    if (window.electron) {
      window.electron.onMaximizeChange((maximized: boolean) => {
        setIsMaximized(maximized);
      });
    }
  }, []);

  const handleMinimize = () => {
    window.electron?.minimizeWindow();
  };

  const handleMaximize = () => {
    window.electron?.maximizeWindow();
  };

  const handleClose = () => {
    window.electron?.closeWindow();
  };

  // Don't render title bar if not in electron
  if (!window.electron) return null;

  return (
    <div className="title-bar">
      <div className="title-bar-drag-area">
        <span className="title-bar-text">Vigil</span>
      </div>
      <div className="window-controls">
        <button className="window-control minimize" onClick={handleMinimize}>
          <svg width="10" height="1" viewBox="0 0 10 1">
            <path d="M0 0h10v1H0z" fill="currentColor" />
          </svg>
        </button>
        <button className="window-control maximize" onClick={handleMaximize}>
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M2.1,0v2H0v8h8V8h2V0H2.1z M7,9H1V3h6V9z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M0 0v10h10V0H0zm9 9H1V1h8v8z" fill="currentColor" />
            </svg>
          )}
        </button>
        <button className="window-control close" onClick={handleClose}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1.41 0L0 1.41l3.59 3.59L0 8.59 1.41 10l3.59-3.59L8.59 10 10 8.59 6.41 5 10 1.41 8.59 0 5 3.59 1.41 0z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>
  );
}