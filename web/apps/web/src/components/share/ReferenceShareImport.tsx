import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ReferenceShare } from "@print-partner/contracts";
import { fetchSources } from "../../api/endpoints/sources";
import { engineFetch } from "../../api/engineTransport";
import { planRoute } from "../../lib/routes";
import { Button } from "../ui/button";

type Dependency = { source_key: string; path: string; status: string };
type Inspection = { dependencies: Dependency[]; printable: boolean };

function numericMapping(mapping: Record<string, string>): Record<string, number> {
  const numeric: Record<string, number> = {};
  for (const [key, value] of Object.entries(mapping)) {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0) numeric[key] = id;
  }
  return numeric;
}

export default function ReferenceShareImport({
  manifest,
}: {
  manifest: Extract<ReferenceShare, { kind: "build" }>;
}) {
  const navigate = useNavigate();
  const [sources, setSources] = useState<Array<{ id: number; name: string }>>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const included = manifest.parts.filter((part) => part.included);

  useEffect(() => {
    let active = true;
    void fetchSources()
      .then((rows) => {
        if (active) setSources(rows.map((row) => ({ id: row.id, name: row.name })));
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : "Library could not be loaded");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const selected = numericMapping(mapping);
    if (Object.keys(selected).length === 0 || included.length === 0) {
      setInspection(null);
      return;
    }
    let active = true;
    void engineFetch<Inspection>("/reference-shares/dependencies", {
      method: "POST",
      body: JSON.stringify({ manifest, mapping: selected }),
    })
      .then((result) => {
        if (active) setInspection(result);
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : "Dependencies could not be checked");
      });
    return () => {
      active = false;
    };
  }, [included.length, manifest, mapping]);

  async function onImport() {
    setBusy(true);
    setError(null);
    try {
      const result = await engineFetch<{ profile_id: number }>("/reference-shares/imports", {
        method: "POST",
        body: JSON.stringify({ manifest, mapping: numericMapping(mapping) }),
      });
      navigate(planRoute(result.profile_id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Build was not created");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Choose the Library Source you already have for each reference. Print Partner does not download models or match a source by name.
      </p>
      {manifest.sources.map((source) => (
        <label key={source.key} className="block text-sm">
          Map {source.name}
          <select
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            aria-label={`Map ${source.name}`}
            value={mapping[source.key] ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              setMapping((current) => ({ ...current, [source.key]: value }));
            }}
          >
            <option value="">Choose a Library Source</option>
            {sources.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.name}</option>
            ))}
          </select>
        </label>
      ))}
      {included.length === 0 ? (
        <p className="text-sm text-muted-foreground">This recipe has no included parts, so it cannot become a printable Build.</p>
      ) : null}
      {inspection ? (
        <ul className="space-y-1 text-sm">
          {inspection.dependencies.map((entry) => (
            <li key={`${entry.source_key}:${entry.path}`}>{entry.path}: {entry.status}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <Button type="button" disabled={inspection?.printable !== true || busy} onClick={() => void onImport()}>
        Add to my Builds
      </Button>
    </div>
  );
}
