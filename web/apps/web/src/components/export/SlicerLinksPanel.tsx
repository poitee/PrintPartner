/**
 * Open-the-slicer buttons — prefers enabled Slicer Hub instances from the API.
 * Falls back to hardcoded SLICER_LINKS when no enabled instances exist yet.
 */
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { fetchSlicerInstances, type SlicerInstance } from "../../api/engine";
import { SLICER_LINKS } from "../../lib/slicerLinks";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";

type LinkRow = { key: string; label: string; url: string; hint?: string };

function linksFromInstances(instances: SlicerInstance[]): LinkRow[] {
  return instances
    .filter((row) => {
      if (!row.enabled) return false;
      const url = row.gui_url.trim();
      if (!url) return false;
      try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    })
    .map((row) => ({
      key: row.id,
      label: row.name,
      url: row.gui_url.trim(),
      hint: row.watch_path || undefined,
    }));
}

export default function SlicerLinksPanel() {
  const [links, setLinks] = useState<LinkRow[]>(
    SLICER_LINKS.map((link) => ({
      key: link.slicer,
      label: link.label,
      url: link.url,
      hint: link.hint,
    })),
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const instances = await fetchSlicerInstances();
        if (cancelled) return;
        if (instances.length > 0) {
          setLinks(linksFromInstances(instances));
        }
      } catch {
        // Keep hardcoded fallback when the API is unavailable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="gap-1 pb-2">
        <CardTitle level={3} className="text-[13.5px] font-semibold leading-snug">Open a slicer</CardTitle>
        <CardDescription className="text-[12.5px] leading-relaxed">
          Jump into the running slicer GUI to inspect or tweak a plate directly.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2 pt-0">
        {links.map((link) => (
          <Button key={link.key} variant="outline" size="sm" asChild className="gap-1.5" title={link.hint}>
            <a href={link.url} target="_blank" rel="noreferrer noopener">
              {link.label}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
