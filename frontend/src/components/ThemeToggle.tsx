import { Moon, Sun } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { Hint } from "./Hint";
import { Button } from "./ui/button";

type Theme = "light" | "dark";

function initialTheme(): Theme {
  const stored = storage((s) => s.getItem("paitrace-theme"));
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** localStorage can be entirely absent or throw on access (sandboxed iframe). */
function storage<T>(use: (s: Storage) => T): T | null {
  try {
    return use(globalThis.localStorage);
  } catch {
    return null;
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    storage((s) => s.setItem("paitrace-theme", theme));
  }, [theme]);

  return (
    <Hint label="Toggle theme">
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        aria-label="Toggle theme"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? <Sun /> : <Moon />}
      </Button>
    </Hint>
  );
}
