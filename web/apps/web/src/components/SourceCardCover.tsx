import { useEffect, useState } from "react";
import { Archive, Box, FolderOpen, GitBranch, Globe } from "lucide-react";
import { sourceCoverUrl } from "../api/engine";
import { cn } from "../lib/utils";

type SourceKind = string;

const KIND_ICONS: Record<string, typeof GitBranch> = {
  github: GitBranch,
  local: FolderOpen,
  printables: Box,
  makerworld: Box,
  archive: Archive,
  self: Globe,
};

function hashHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function CoverFallback({
  name,
  sourceKind,
  compact,
}: {
  name: string;
  sourceKind: SourceKind;
  compact?: boolean;
}) {
  const Icon = KIND_ICONS[sourceKind] ?? Globe;
  const hue = hashHue(name);
  return (
    <div
      className={cn(
        "relative flex w-full items-center justify-center overflow-hidden bg-secondary",
        compact ? "h-16" : "h-32",
      )}
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 42% 22%) 0%, hsl(${(hue + 40) % 360} 35% 14%) 100%)`,
      }}
    >
      <Icon
        className={cn(
          "text-foreground/25",
          compact ? "h-8 w-8" : "h-14 w-14",
        )}
        strokeWidth={1.25}
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-card via-transparent to-transparent" />
    </div>
  );
}

type Props = {
  sourceId: number;
  name: string;
  sourceKind: SourceKind;
  compact?: boolean;
  /** Hide the kind chip overlaid on the cover (Library cards show kind elsewhere). */
  hideKindBadge?: boolean;
  /** Square 30px thumb for Plan attached-source rows. */
  thumb?: boolean;
  className?: string;
};

export default function SourceCardCover({
  sourceId,
  name,
  sourceKind,
  compact,
  hideKindBadge = false,
  thumb = false,
  className,
}: Props) {
  const [coverSrc, setCoverSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setCoverSrc(null);
    void sourceCoverUrl(sourceId).then((url) => {
      if (!cancelled) setCoverSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [sourceId, name, sourceKind]);

  if (thumb) {
    const Icon = KIND_ICONS[sourceKind] ?? Globe;
    const hue = hashHue(name);
    if (failed || !coverSrc) {
      return (
        <div
          className={cn(
            "flex h-[30px] w-[30px] items-center justify-center overflow-hidden rounded-md border border-border",
            className,
          )}
          style={{
            background: `linear-gradient(135deg, hsl(${hue} 42% 22%) 0%, hsl(${(hue + 40) % 360} 35% 14%) 100%)`,
          }}
          aria-hidden
        >
          <Icon className="h-3.5 w-3.5 text-foreground/40" strokeWidth={1.5} />
        </div>
      );
    }
    return (
      <div
        className={cn(
          "h-[30px] w-[30px] overflow-hidden rounded-md border border-border",
          className,
        )}
      >
        <img
          src={coverSrc}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </div>
    );
  }

  if (failed || !coverSrc) {
    return (
      <div className={className}>
        <CoverFallback name={name} sourceKind={sourceKind} compact={compact} />
      </div>
    );
  }

  return (
    <div className={cn("relative w-full overflow-hidden", className)}>
      <img
        src={coverSrc}
        alt=""
        className={cn("w-full object-cover", compact ? "h-16" : "h-32")}
        loading="lazy"
        onError={() => setFailed(true)}
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-card via-card/30 to-transparent" />
      {!hideKindBadge ? (
        <div className="absolute bottom-2 left-2 rounded-md border border-border/60 bg-card/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur-sm">
          {sourceKind === "github" ? "GitHub" : sourceKind}
        </div>
      ) : null}
    </div>
  );
}
