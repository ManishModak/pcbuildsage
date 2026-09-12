"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { cn } from "./cn";
import { Icon } from "./icon";

export interface SearchableModelOption {
  id: string;
  name?: string;
}

export interface SearchableModelSelectProps {
  value: string;
  onChange: (value: string) => void;
  models: SearchableModelOption[];
  placeholder?: string;
  disabled?: boolean;
  providerId?: "gemini" | "openrouter";
  className?: string;
  "data-testid"?: string;
  defaultOpen?: boolean;
}

const OPENROUTER_TAGS = [
  { label: "All", tag: null },
  { label: "Free", tag: ":free" },
  { label: "Claude", tag: "claude" },
  { label: "GPT", tag: "gpt" },
  { label: "DeepSeek", tag: "deepseek" },
  { label: "Llama", tag: "llama" },
  { label: "Gemini", tag: "gemini" }
];

export function SearchableModelSelect({
  value,
  onChange,
  models,
  placeholder = "Select a model...",
  disabled = false,
  providerId,
  className,
  "data-testid": testId,
  defaultOpen = false
}: SearchableModelSelectProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [isCustomMode, setIsCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close on outside click or Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  const filteredModels = useMemo(() => {
    let list = models;

    if (activeTag) {
      const lowerTag = activeTag.toLowerCase();
      list = list.filter(
        (m) =>
          m.id.toLowerCase().includes(lowerTag) ||
          (m.name && m.name.toLowerCase().includes(lowerTag))
      );
    }

    const query = search.trim().toLowerCase();
    if (query) {
      list = list.filter(
        (m) =>
          m.id.toLowerCase().includes(query) ||
          (m.name && m.name.toLowerCase().includes(query))
      );
    }

    return list;
  }, [models, search, activeTag]);

  const selectedModel = models.find((m) => m.id === value);
  const displayName = selectedModel?.name && selectedModel.name !== value
    ? selectedModel.name
    : value || placeholder;

  const handleSelect = (modelId: string) => {
    onChange(modelId);
    setIsOpen(false);
    setSearch("");
    setIsCustomMode(false);
  };

  const handleApplyCustom = () => {
    const trimmed = customValue.trim();
    if (trimmed) {
      onChange(trimmed);
      setIsOpen(false);
      setIsCustomMode(false);
      setCustomValue("");
    }
  };

  const showTags = providerId === "openrouter";

  return (
    <div ref={containerRef} className={cn("relative w-full", className)} data-testid={testId}>
      {/* Trigger Button */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((prev) => !prev)}
        className={cn(
          "w-full min-h-11 flex items-center justify-between gap-2 rounded-btn border border-border bg-surface px-3 py-2 text-left text-sm transition-colors duration-150",
          "hover:border-border-hover focus:outline-none focus:border-accent",
          disabled && "opacity-50 cursor-not-allowed",
          isOpen && "border-accent ring-1 ring-accent/20"
        )}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <div className="flex flex-col min-w-0 flex-1">
          <span className="font-medium text-text truncate">{displayName}</span>
          {selectedModel?.name && selectedModel.name !== value ? (
            <span className="font-mono text-xs text-text-muted truncate">{value}</span>
          ) : null}
        </div>
        <Icon
          icon={ChevronDown}
          size={16}
          className={cn("text-text-secondary shrink-0 transition-transform duration-150", isOpen && "rotate-180")}
        />
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div
          className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-btn border border-border bg-surface shadow-xl flex flex-col max-h-[380px] overflow-hidden"
          role="listbox"
        >
          {isCustomMode ? (
            /* Custom Model Entry Mode */
            <div className="p-3 flex flex-col gap-3">
              <span className="text-xs font-semibold text-text">Enter Custom Model ID</span>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="e.g. meta-llama/llama-3.3-70b-instruct"
                  value={customValue}
                  onChange={(e) => setCustomValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleApplyCustom();
                    }
                  }}
                  className="flex-1 font-mono text-sm px-2.5 py-1.5 rounded-btn border border-border bg-surface-raised text-text focus:outline-none focus:border-accent"
                  autoFocus
                />
                <button
                  type="button"
                  disabled={!customValue.trim()}
                  onClick={handleApplyCustom}
                  className="px-3 py-1.5 text-xs font-medium rounded-btn bg-accent text-accent-contrast disabled:opacity-50 cursor-pointer"
                >
                  Apply
                </button>
              </div>
              <button
                type="button"
                onClick={() => setIsCustomMode(false)}
                className="text-xs text-text-secondary hover:text-text self-start cursor-pointer"
              >
                ← Back to model list
              </button>
            </div>
          ) : (
            /* Search & List Mode */
            <>
              {/* Search Bar */}
              <div className="p-2 border-b border-border bg-surface">
                <div className="relative flex items-center">
                  <Icon icon={Search} size={15} className="absolute left-2.5 text-text-muted pointer-events-none" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    placeholder={`Search ${models.length} models by name or ID...`}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full pl-8 pr-8 py-1.5 text-sm rounded-btn border border-border bg-surface-raised text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
                  />
                  {search ? (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      className="absolute right-2 text-text-muted hover:text-text p-0.5 cursor-pointer"
                      aria-label="Clear search"
                    >
                      <Icon icon={X} size={14} />
                    </button>
                  ) : null}
                </div>

                {/* Quick Filter Tag Pills */}
                {showTags && (
                  <div className="flex items-center gap-1.5 pt-2 overflow-x-auto scrollbar-none">
                    {OPENROUTER_TAGS.map((item) => {
                      const isSelected = activeTag === item.tag;
                      return (
                        <button
                          key={item.label}
                          type="button"
                          onClick={() => setActiveTag(isSelected ? null : item.tag)}
                          className={cn(
                            "px-2 py-0.5 text-caption rounded-pill font-medium shrink-0 transition-colors cursor-pointer",
                            isSelected
                              ? "bg-accent text-accent-contrast"
                              : "bg-surface-raised text-text-secondary hover:text-text hover:bg-surface-raised/80"
                          )}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Status Header */}
              <div className="px-3 py-1.5 bg-surface-raised/50 border-b border-border/50 flex items-center justify-between text-caption text-text-muted">
                <span>
                  Showing {filteredModels.length} of {models.length} models
                </span>
                <button
                  type="button"
                  onClick={() => setIsCustomMode(true)}
                  className="text-accent hover:underline cursor-pointer font-medium"
                >
                  + Custom ID
                </button>
              </div>

              {/* Scrollable Model List */}
              <div className="flex-1 overflow-y-auto max-h-[240px] divide-y divide-border/40 scrollbar-none">
                {filteredModels.length === 0 ? (
                  <div className="p-4 text-center flex flex-col items-center gap-2">
                    <span className="text-sm text-text-secondary">
                      No models match &ldquo;{search}&rdquo;
                    </span>
                    <button
                      type="button"
                      onClick={() => handleSelect(search)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline cursor-pointer"
                    >
                      <Icon icon={Plus} size={13} />
                      Use &ldquo;{search}&rdquo; as custom model ID
                    </button>
                  </div>
                ) : (
                  filteredModels.map((model) => {
                    const isSelected = model.id === value;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => handleSelect(model.id)}
                        className={cn(
                          "w-full px-3 py-2 flex items-center justify-between gap-3 text-left transition-colors cursor-pointer",
                          "hover:bg-surface-raised/80",
                          isSelected && "bg-accent/10"
                        )}
                      >
                        <div className="flex flex-col min-w-0 flex-1">
                          <span
                            className={cn(
                              "text-sm truncate",
                              isSelected ? "font-semibold text-accent" : "text-text"
                            )}
                          >
                            {model.name && model.name !== model.id ? model.name : model.id}
                          </span>
                          {model.name && model.name !== model.id ? (
                            <span className="font-mono text-xs text-text-muted truncate">
                              {model.id}
                            </span>
                          ) : null}
                        </div>
                        {isSelected && (
                          <Icon icon={Check} size={15} className="text-accent shrink-0" />
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
