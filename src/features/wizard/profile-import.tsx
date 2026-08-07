"use client";

import { useRef, useState } from "react";
import { FileUp, Link2, OctagonX } from "lucide-react";
import { importProfileFromFile, importProfileFromUrl, type ImportResult } from "@/lib/api-client";
import { Icon } from "@/components/ui/icon";
import { Dialog } from "@/components/ui/dialog";
import { Button, Field, Input } from "@/components/ui/primitives";

export function ProfileImportDialog({
  open,
  onClose,
  onImported
}: {
  open: boolean;
  onClose: () => void;
  onImported: (id?: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handle = async (run: () => Promise<ImportResult>) => {
    setBusy(true);
    setErrors([]);
    try {
      const result = await run();
      if (result.ok) {
        onImported(result.filename?.replace(/\.json$/, ""));
        onClose();
      } else {
        setErrors(result.errors);
      }
    } catch (error) {
      setErrors([(error as Error).message]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import a scrape profile"
      description="Add a community profile from a file or URL. It is validated against the schema before saving."
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handle(() => importProfileFromFile(file));
              event.target.value = "";
            }}
          />
          <Button variant="ghost" iconLeft={FileUp} disabled={busy} onClick={() => fileRef.current?.click()}>
            Choose a JSON file
          </Button>
        </div>

        <div className="flex items-center gap-3 text-caption text-text-muted">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>

        <Field label="Profile URL">
          <div className="flex gap-2">
            <Input
              value={url}
              mono
              placeholder="https://…/india.json"
              onChange={(event) => setUrl(event.target.value)}
            />
            <Button
              variant="ghost"
              iconLeft={Link2}
              loading={busy}
              disabled={!url.trim()}
              onClick={() => void handle(() => importProfileFromUrl(url.trim()))}
            >
              Fetch
            </Button>
          </div>
        </Field>

        {errors.length ? (
          <div
            className="flex flex-col gap-2 rounded-card border px-3 py-3"
            style={{ borderColor: "color-mix(in srgb, var(--blocking) 45%, transparent)" }}
          >
            <p className="flex items-center gap-2 text-caption font-medium" style={{ color: "var(--blocking)" }}>
              <Icon icon={OctagonX} size={14} />
              Profile rejected — {errors.length} schema {errors.length === 1 ? "error" : "errors"}
            </p>
            <ul className="flex flex-col gap-1 font-mono text-caption text-text-secondary">
              {errors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
