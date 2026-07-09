import { useEffect, useRef, useState } from "react";
import { saveDraft, type StashFile } from "../lib/stash.js";
import type { InputBoxHandle } from "./input-box.js";

export interface UseInputBufferOptions {
  disabled: boolean;
  workspaceRoot: string;
  initialDraft?: string;
  stashRef: { current: StashFile };
  onStashChange: (next: StashFile) => void;
  onDraftChange?: (value: string) => void;
  onEdited?: () => void;
  handleRef?: React.MutableRefObject<InputBoxHandle | null>;
}

interface InputBuffer {
  value: string;
  cursor: number;
  setCursor: React.Dispatch<React.SetStateAction<number>>;
  valueRef: React.MutableRefObject<string>;
  cursorRef: React.MutableRefObject<number>;
  setDraftValue: (next: string, nextCursor?: number) => void;
  update: (next: string, nextCursor?: number) => void;
  insertText: (text: string) => void;
  moveCursorVertical: (dir: -1 | 1) => void;
}

export function useInputBuffer(options: UseInputBufferOptions): InputBuffer {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const valueRef = useRef(value);
  const cursorRef = useRef(cursor);

  valueRef.current = value;
  cursorRef.current = cursor;

  function setDraftValue(next: string, nextCursor?: number): void {
    const resolvedCursor = nextCursor ?? next.length;
    valueRef.current = next;
    cursorRef.current = resolvedCursor;
    setValue(next);
    setCursor(resolvedCursor);
    options.onDraftChange?.(next);
  }

  function update(next: string, nextCursor?: number): void {
    setDraftValue(next, nextCursor);
    options.onEdited?.();
  }

  function insertText(text: string): void {
    if (!text) return;
    const currentValue = valueRef.current;
    const currentCursor = cursorRef.current;
    const next =
      currentValue.slice(0, currentCursor) +
      text +
      currentValue.slice(currentCursor);
    update(next, currentCursor + text.length);
  }

  function moveCursorVertical(dir: -1 | 1): void {
    const currentValue = valueRef.current;
    const currentCursor = cursorRef.current;
    const lineStart = currentValue.lastIndexOf("\n", currentCursor - 1) + 1;
    const col = currentCursor - lineStart;
    if (dir === -1) {
      if (lineStart === 0) return;
      const prevLineEnd = lineStart - 1;
      const prevLineStart = currentValue.lastIndexOf("\n", prevLineEnd - 1) + 1;
      const prevLineLen = prevLineEnd - prevLineStart;
      setCursor(prevLineStart + Math.min(col, prevLineLen));
      return;
    }
    const nlIdx = currentValue.indexOf("\n", currentCursor);
    if (nlIdx === -1) return;
    const nextLineStart = nlIdx + 1;
    let nextLineEnd = currentValue.indexOf("\n", nextLineStart);
    if (nextLineEnd === -1) nextLineEnd = currentValue.length;
    const nextLineLen = nextLineEnd - nextLineStart;
    setCursor(nextLineStart + Math.min(col, nextLineLen));
  }

  useEffect(() => {
    const initial = options.initialDraft;
    const current = options.stashRef.current.current;
    const text =
      initial && initial.length > 0
        ? initial
        : current && current.text.length > 0
          ? current.text
          : "";
    if (text.length > 0 && valueRef.current.length === 0) {
      setDraftValue(text);
    }
  }, [options.workspaceRoot]);

  useEffect(() => {
    if (!options.handleRef) return;
    options.handleRef.current = {
      setValue: (text: string) => update(text),
      getValue: () => valueRef.current,
    };
    return () => {
      if (options.handleRef) options.handleRef.current = null;
    };
  }, [options.handleRef]);

  useEffect(() => {
    if (options.disabled) return;
    const id = setTimeout(() => {
      void saveDraft(
        options.workspaceRoot,
        value,
        options.stashRef.current,
      ).then(options.onStashChange);
    }, 600);
    return () => clearTimeout(id);
  }, [value, options.workspaceRoot, options.disabled]);

  return {
    value,
    cursor,
    setCursor,
    valueRef,
    cursorRef,
    setDraftValue,
    update,
    insertText,
    moveCursorVertical,
  };
}
