import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

const STORAGE_KEY = "wakeel-studio-theme";
type Theme = "light" | "dark";

function effectiveTheme(): Theme {
  if (typeof document === "undefined") return "light";
  const pinned = document.documentElement.dataset["theme"];
  if (pinned === "light" || pinned === "dark") return pinned;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Uses the existing data-theme contract; the inline boot script applies a saved theme before paint. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(effectiveTheme);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setTheme(effectiveTheme());
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const next = theme === "light" ? "dark" : "light";
  const label = `Switch to ${next} theme`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="wk-press flex size-control items-center justify-center rounded-sm border border-hairline bg-surface text-secondary hover:bg-subtle hover:text-primary"
      onClick={() => {
        document.documentElement.dataset["theme"] = next;
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // Browsers with disabled storage can still switch themes for this page.
        }
        setTheme(next);
      }}
    >
      {theme === "light" ? (
        <Moon className="size-icon" aria-hidden="true" />
      ) : (
        <Sun className="size-icon" aria-hidden="true" />
      )}
    </button>
  );
}
