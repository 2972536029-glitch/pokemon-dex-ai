import { useEffect, useState } from "react";

const STORAGE_KEY = "pkmn.theme";

// Three modes:
//   "light" / "dark" — explicit user choice, persisted
//   "auto"           — follow the OS, re-evaluated when the OS changes
const SYSTEM_QUERY = "(prefers-color-scheme: dark)";

// Read the OS preference once. matchMedia is widely supported; fall back to
// "light" on very old browsers.
function systemPrefersDark() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.(SYSTEM_QUERY)?.matches
  );
}

// Resolve the effective theme ("light" / "dark") from the current mode.
function resolveTheme(mode) {
  if (mode === "auto") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

// Theme toggle backed by localStorage. Supports a third mode "auto" that
// follows the OS, re-evaluated live via a matchMedia listener.
export function useTheme() {
  const [mode, setMode] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || "auto";
    } catch {
      return "auto";
    }
  });

  // The actual theme applied to <html>, derived from the mode.
  const [theme, setTheme] = useState(() => resolveTheme(mode));

  // Apply the resolved theme to <html> + keep React state in sync.
  // Single source of truth — both effects below call this.
  function applyTheme(resolved) {
    setTheme(resolved);
    document.documentElement.setAttribute("data-theme", resolved);
  }

  // Persist the *mode* (not the resolved theme, so "auto" survives reloads)
  // and apply the current resolved theme whenever the mode changes.
  useEffect(() => {
    applyTheme(resolveTheme(mode));
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // ignore
    }
  }, [mode]);

  // When in "auto" mode, listen for OS theme changes and re-apply live.
  useEffect(() => {
    if (mode !== "auto") return;
    const mql = window.matchMedia(SYSTEM_QUERY);
    const onChange = () => applyTheme(systemPrefersDark() ? "dark" : "light");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [mode]);

  // Cycler: auto → light → dark → auto. Lets the user preview all three.
  const toggle = () => {
    setMode((m) => (m === "auto" ? "light" : m === "light" ? "dark" : "auto"));
  };

  return { mode, theme, toggle };
}
