import { useEffect, useMemo, useState } from "react";
import type { Key } from "ink";
import {
  appendHistory,
  loadHistory,
  type HistoryEntry,
} from "../lib/history.js";

export interface UseInputHistoryOptions {
  workspaceRoot: string;
  currentValue: string;
  setDraftValue: (next: string, nextCursor?: number) => void;
}

export interface InputHistory {
  history: HistoryEntry[];
  searchQuery: string | null;
  searchMatches: HistoryEntry[];
  safeSearchCursor: number;
  resetRecall: () => void;
  clearDraftSnapshot: () => void;
  recall: (direction: -1 | 1) => void;
  append: (text: string) => Promise<void>;
  startSearch: () => boolean;
  handleSearchInput: (input: string, key: Key) => boolean;
}

export function useInputHistory(options: UseInputHistoryOptions): InputHistory {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [searchCursor, setSearchCursor] = useState(0);

  useEffect(() => {
    void loadHistory(options.workspaceRoot).then(setHistory);
  }, [options.workspaceRoot]);

  const searchMatches = useMemo(() => {
    if (searchQuery === null) return [];
    const q = searchQuery.toLowerCase();
    const out: HistoryEntry[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (!q || entry.text.toLowerCase().includes(q)) out.push(entry);
      if (out.length >= 8) break;
    }
    return out;
  }, [history, searchQuery]);

  const safeSearchCursor = Math.min(
    searchCursor,
    Math.max(0, searchMatches.length - 1),
  );

  function resetRecall(): void {
    setHistoryIdx(null);
  }

  function clearDraftSnapshot(): void {
    setDraft("");
  }

  function recall(direction: -1 | 1): void {
    if (history.length === 0) return;
    if (historyIdx === null) {
      if (direction === 1) return;
      setDraft(options.currentValue);
      const idx = history.length - 1;
      setHistoryIdx(idx);
      options.setDraftValue(history[idx].text);
      return;
    }
    const next = historyIdx + direction;
    if (next < 0) {
      setHistoryIdx(0);
      return;
    }
    if (next >= history.length) {
      setHistoryIdx(null);
      options.setDraftValue(draft);
      return;
    }
    setHistoryIdx(next);
    options.setDraftValue(history[next].text);
  }

  async function append(text: string): Promise<void> {
    setHistory(await appendHistory(options.workspaceRoot, text, history));
  }

  function startSearch(): boolean {
    if (history.length === 0) return false;
    setSearchQuery("");
    setSearchCursor(0);
    return true;
  }

  function handleSearchInput(input: string, key: Key): boolean {
    if (searchQuery === null) return false;
    if (key.escape) {
      setSearchQuery(null);
      return true;
    }
    if (key.return) {
      const pick = searchMatches[safeSearchCursor];
      if (pick) options.setDraftValue(pick.text);
      setSearchQuery(null);
      return true;
    }
    if (key.upArrow) {
      setSearchCursor((c) => Math.min(searchMatches.length - 1, c + 1));
      return true;
    }
    if (key.downArrow) {
      setSearchCursor((c) => Math.max(0, c - 1));
      return true;
    }
    if (key.backspace || key.delete) {
      setSearchQuery((q) => (q ? q.slice(0, -1) : ""));
      setSearchCursor(0);
      return true;
    }
    if (key.ctrl && input === "r") {
      setSearchCursor((c) => Math.min(searchMatches.length - 1, c + 1));
      return true;
    }
    if (key.ctrl || key.meta || key.tab) return true;
    if (input && input.length > 0) {
      setSearchQuery((q) => (q ?? "") + input);
      setSearchCursor(0);
    }
    return true;
  }

  return {
    history,
    searchQuery,
    searchMatches,
    safeSearchCursor,
    resetRecall,
    clearDraftSnapshot,
    recall,
    append,
    startSearch,
    handleSearchInput,
  };
}
