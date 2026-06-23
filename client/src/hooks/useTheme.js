import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'diun-theme';

function getInitialTheme() {
  if (typeof window === 'undefined') return 'dark';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // localStorage may be unavailable (private mode, etc.) — fall through.
  }
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Tiny module-level theme state shared across every useTheme() call, so the
 * toggle in the header and the one in Settings stay in sync without needing
 * a context provider. Initialized lazily on first import.
 */
let currentTheme = null;
const listeners = new Set();

function ensureInitialized() {
  if (currentTheme === null) {
    currentTheme = getInitialTheme();
    applyTheme(currentTheme);
  }
}

function setTheme(theme) {
  currentTheme = theme;
  applyTheme(theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Best-effort persistence only.
  }
  listeners.forEach((listener) => listener(theme));
}

/**
 * Returns `{ theme, toggle }`. `theme` is 'dark' | 'light', read from
 * localStorage('diun-theme') or `prefers-color-scheme` on first use.
 * `toggle()` flips the theme, persists it, and sets `data-theme` on
 * `<html>` (which is all styles/themes.css needs to re-theme everything).
 */
export function useTheme() {
  ensureInitialized();
  const [theme, setLocalTheme] = useState(currentTheme);

  useEffect(() => {
    listeners.add(setLocalTheme);
    return () => listeners.delete(setLocalTheme);
  }, []);

  const toggle = useCallback(() => {
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
  }, []);

  return { theme, toggle };
}
