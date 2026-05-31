import React, { createContext, useContext } from "react";
import { DARK, type Theme } from "./theme.js";

const ThemeCtx = createContext<Theme>(DARK);

export function ThemeProvider(props: {
  theme: Theme;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ThemeCtx.Provider value={props.theme}>{props.children}</ThemeCtx.Provider>
  );
}

export function useTheme(): Theme {
  return useContext(ThemeCtx);
}
