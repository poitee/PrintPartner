import { lazy, Suspense } from "react";
const Preview3D = lazy(() => import("../Preview3D"));
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { cn } from "../../lib/utils";

export type PreviewDialogPart = {
  id?: number;
  sourceId?: number;
  relativePath?: string;
  filename: string;
  filament_hex?: string | null;
  /** When true, preview the synced source STL instead of the plan part row. */
  preferSource?: boolean;
};

type Props = {
  part: PreviewDialogPart | null;
  onClose: () => void;
  /** Larger dialog for Build page source previews. */
  size?: "default" | "large";
};

function isSourcePreview(part: PreviewDialogPart): boolean {
  return (
    part.preferSource === true ||
    (part.id == null && part.sourceId != null && Boolean(part.relativePath))
  );
}

/**
 * Expanded 3D preview for a sheet thumbnail or Build source STL. Render ONE
 * instance per page/sheet (controlled by which part is selected) so at most one
 * WebGL renderer exists at a time; Preview3D disposes its renderer, controls,
 * geometry and material when the dialog content unmounts on close.
 */
export default function PartPreviewDialog({ part, onClose, size = "default" }: Props) {
  const sourceMode = part != null && isSourcePreview(part);

  return (
    <Dialog
      open={part != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className={cn(size === "large" ? "max-w-4xl" : "max-w-2xl")}>
        {part && (
          <>
            <DialogHeader>
              <DialogTitle className="break-all pr-8 text-base">{part.filename}</DialogTitle>
            </DialogHeader>
            <p className="text-xs text-muted-foreground">
              Drag to rotate · scroll or pinch to zoom
            </p>
            <Suspense fallback={<div className="flex items-center justify-center" style={{minHeight: 160}}>Loading 3D…</div>}>
              <Preview3D
                partId={sourceMode ? null : (part.id ?? null)}
                sourceId={sourceMode ? part.sourceId : null}
                relativePath={sourceMode ? part.relativePath : null}
                preferSource={sourceMode}
                meshColor={part.filament_hex || undefined}
                className={size === "large" ? "min-h-[420px]" : undefined}
              />
            </Suspense>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
