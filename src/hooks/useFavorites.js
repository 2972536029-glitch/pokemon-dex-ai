import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "pkmn.favorites";

// Read once from localStorage, tolerating old/corrupt data.
function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Favorites list backed by localStorage.
// Each favorite is a small object: { id, name, image } — just enough to
// render the bar without refetching.
export function useFavorites() {
  const [favorites, setFavorites] = useState(readStored);

  // Persist whenever the list changes.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
    } catch {
      // Quota exceeded / private mode — ignore, favorites just won't persist.
    }
  }, [favorites]);

  const isFavorite = useCallback(
    (id) => favorites.some((f) => f.id === id),
    [favorites]
  );

  const toggleFavorite = useCallback((entry) => {
    setFavorites((prev) => {
      const exists = prev.some((f) => f.id === entry.id);
      return exists
        ? prev.filter((f) => f.id !== entry.id)
        : [{ id: entry.id, name: entry.name, image: entry.image }, ...prev];
    });
  }, []);

  const removeFavorite = useCallback((id) => {
    setFavorites((prev) => prev.filter((f) => f.id !== id));
  }, []);

  return { favorites, isFavorite, toggleFavorite, removeFavorite };
}
