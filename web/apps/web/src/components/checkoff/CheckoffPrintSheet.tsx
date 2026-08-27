import type { Ref } from "react";
import type { ReviewPart } from "../../api/endpoints/planManifests";
import type { CheckoffRepoGroup } from "../../lib/checkoffGroups";
import type { PrintSheetLayout } from "./CheckoffPrintSheetButton";
import CheckoffSheetRow from "./CheckoffSheetRow";
import { cn } from "@/lib/utils";

type Props = {
  sheetRef: Ref<HTMLElement>;
  planName: string;
  partCount: number;
  printedLine: string;
  groups: CheckoffRepoGroup[];
  layout: PrintSheetLayout;
  /** True while the browser is preparing the sheet for the print dialog. */
  printPrep: boolean;
  busyPartId: number | null;
  toggleBusy: boolean;
  onToggleUnit: (part: ReviewPart, unitIndex: number) => void;
  onPreview: (part: ReviewPart) => void;
};

/**
 * The paper packing sheet. Print-only on screen: it exists for the bench, not
 * for the console, so it never competes with the operator's live worklist.
 */
export default function CheckoffPrintSheet({
  sheetRef,
  planName,
  partCount,
  printedLine,
  groups,
  layout,
  printPrep,
  busyPartId,
  toggleBusy,
  onToggleUnit,
  onPreview,
}: Props) {
  return (
    <article
      ref={sheetRef}
      aria-hidden={!printPrep}
      className={cn(
        "checkoff-sheet checkoff-sheet-print-only",
        layout.compactMode && "compact",
        layout.continuousPrintLayout && "checkoff-sheet-print-continuous",
        layout.textOnlyPrint && "checkoff-sheet-text-only",
        printPrep && "is-print-prep",
        printPrep
          ? "pointer-events-none fixed top-0 left-0 -z-10 w-[880px] opacity-0 print:pointer-events-auto print:relative print:z-auto print:w-auto print:opacity-100"
          : null,
      )}
    >
      <header className="sheet-header">
        <h2 className="sheet-title">{planName}</h2>
        <p className="sheet-subtitle">
          {partCount} part{partCount === 1 ? "" : "s"} · {printedLine}
        </p>
      </header>

      {groups.map((repo) => (
        <section key={repo.repoLayer} className="sheet-repo">
          <h3 className="sheet-repo-title">
            {repo.repoLabel}
            <span className="sheet-repo-count">{repo.partCount}</span>
          </h3>
          {repo.folders.map((group) => (
            <div key={group.folder} className="sheet-folder">
              <h4 className="sheet-folder-title">{group.folder}</h4>
              <div className="sheet-table-wrap">
                <table className="sheet-table">
                  <thead>
                    <tr>
                      <th className="sheet-cell-part">Part</th>
                      <th className="sheet-cell-qty">Qty</th>
                      <th className="sheet-cell-printed">Printed</th>
                      <th className="sheet-cell-notes">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.parts.map((part) => (
                      <CheckoffSheetRow
                        key={part.id}
                        part={part}
                        busy={busyPartId === part.id || toggleBusy}
                        compact={layout.compactMode}
                        eagerThumbs={printPrep && !layout.textOnlyPrint}
                        showThumb={!layout.textOnlyPrint}
                        onToggleUnit={onToggleUnit}
                        onPreview={onPreview}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      ))}
    </article>
  );
}
