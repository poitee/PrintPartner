import { useId, useState } from "react";
import { Download } from "lucide-react";
import { engineAssetUrl } from "../../api/endpoints/browserFiles";
import { startExportStlPack, type StlPackGroupBy } from "../../api/endpoints/jobs";
import { useJobRunner } from "../../hooks/useJobRunner";
import { Button } from "../ui/button";
import { StatusBadge } from "../ui/status-badge";
import InlineOperationError from "../printers/InlineOperationError";
import { failureMessage } from "../printers/asyncView";

type Props = Readonly<{
  profileId: number;
  /**
   * Required units the operator chose, in the branded `ppu_` spelling. Empty
   * means the whole work package, which is what the server does with no tokens.
   */
  selectedTokens: readonly string[];
  totalUnitCount: number;
  /** Sends the operator back to the panel that owns the unit selection. */
  onOpenUnitSelection: () => void;
}>;

/** Which of the chosen units the operator wants files for. */
type UnitScope = "all" | "remaining";

/** What a finished pack left behind. */
type StlPackArtifact = Readonly<{
  /** Null when the job produced loose files rather than a zip. */
  downloadUrl: string | null;
  serverPath: string | null;
  fileTotal: number;
  warnings: readonly string[];
}>;

/**
 * The export as the operator experiences it.
 *
 * A union rather than parallel `busy` / `error` / `artifact` fields: a pack that
 * is running and also failed and also downloadable is not a state this route
 * has, and a failure has to survive on screen next to the choices that produced
 * it rather than being replaced by the next render.
 */
type PackState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "failed"; message: string }
  | { phase: "ready"; artifact: StlPackArtifact };

const NOTHING_EXPORTED =
  "No unit files came out of this work package. Sync the Sources and clear the Plan blockers, then try again.";

/**
 * Read the artifact out of a job result.
 *
 * The job result is an untyped bag on the wire, so every field is checked
 * before the panel offers it as a download. A missing `download_url` is a real
 * case rather than a fault: the job publishes loose files when there is no
 * bundle to zip, and then the server path is all there is to say.
 */
function readStlPackArtifact(result: Record<string, unknown> | null): StlPackArtifact {
  const downloadUrl = result?.download_url;
  const serverPath = result?.root_path;
  const fileTotal = result?.file_total;
  const warnings = result?.warnings;
  return {
    downloadUrl: typeof downloadUrl === "string" && downloadUrl ? downloadUrl : null,
    serverPath: typeof serverPath === "string" && serverPath ? serverPath : null,
    fileTotal: typeof fileTotal === "number" ? fileTotal : 0,
    warnings: Array.isArray(warnings)
      ? warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
  };
}

/**
 * The unit-files route: hand the operator the files and stop there.
 *
 * No Plates and no printers, so the only decisions are which of the chosen
 * Required units to include and how to arrange the folders. Both are kept beside
 * the button rather than behind a menu, because a failure has to be able to
 * rerun the same choices.
 */
export default function StlRoutePanel({
  profileId,
  selectedTokens,
  totalUnitCount,
  onOpenUnitSelection,
}: Props) {
  const fieldPrefix = useId();
  const job = useJobRunner("stl-export", profileId);
  const [scope, setScope] = useState<UnitScope>("all");
  const [grouping, setGrouping] = useState<StlPackGroupBy>("color_dir");
  const [pack, setPack] = useState<PackState>({ phase: "idle" });

  const chosenCount = selectedTokens.length;

  const download = async () => {
    setPack({ phase: "running" });
    await job.runJob(
      async () => {
        try {
          return await startExportStlPack(profileId, {
            missing_only: scope === "remaining",
            group_by: grouping,
            unit_tokens: selectedTokens,
          });
        } catch (error) {
          // The job runner posts its own row for a start that never became a
          // job, but that row disappears. This one stays with the Retry.
          setPack({
            phase: "failed",
            message: failureMessage(error, "PrintPartner could not start the file download."),
          });
          throw error;
        }
      },
      (snapshot) => {
        if (snapshot.status !== "done") {
          setPack({
            phase: "failed",
            message: snapshot.error || snapshot.message || "The file download failed.",
          });
          return;
        }
        const artifact = readStlPackArtifact(snapshot.result);
        if (artifact.fileTotal === 0) {
          setPack({ phase: "failed", message: artifact.warnings[0] ?? NOTHING_EXPORTED });
          return;
        }
        setPack({ phase: "ready", artifact });
      },
      { profileId },
    );
  };

  return (
    <section aria-label="Download sorted STL files" className="stack-section">
      <div className="stack-row rounded-lg border border-border bg-surface-sunken p-3">
        <p className="text-body">
          {chosenCount > 0 ? (
            <>
              This download holds the files for{" "}
              <span className="tabular font-medium">{chosenCount}</span> of{" "}
              <span className="tabular">{totalUnitCount}</span> Required units.
            </>
          ) : (
            <>
              No Required units are chosen, so this download holds the files for all{" "}
              <span className="tabular">{totalUnitCount}</span> Required units in this work package.
            </>
          )}
        </p>
        <Button
          variant="outline"
          className="min-h-11 self-start"
          onClick={onOpenUnitSelection}
        >
          Change which Required units
        </Button>
      </div>

      <fieldset className="stack-row">
        <legend className="text-body font-medium">Which units go in the download?</legend>
        <label className="flex min-h-11 items-start gap-2 py-1 text-body">
          <input
            type="radio"
            className="mt-1.5 h-4 w-4"
            name={`${fieldPrefix}-scope`}
            checked={scope === "all"}
            onChange={() => setScope("all")}
          />
          <span>
            <span className="block font-medium">Every unit</span>
            <span className="block text-meta text-muted-foreground">
              All the Required units named above, printed or not.
            </span>
          </span>
        </label>
        <label className="flex min-h-11 items-start gap-2 py-1 text-body">
          <input
            type="radio"
            className="mt-1.5 h-4 w-4"
            name={`${fieldPrefix}-scope`}
            checked={scope === "remaining"}
            onChange={() => setScope("remaining")}
          />
          <span>
            <span className="block font-medium">Only the ones still to print</span>
            <span className="block text-meta text-muted-foreground">
              Leaves out the units Checkoff has already verified.
            </span>
          </span>
        </label>
      </fieldset>

      <fieldset className="stack-row">
        <legend className="text-body font-medium">How should the files be arranged?</legend>
        <label className="flex min-h-11 items-start gap-2 py-1 text-body">
          <input
            type="radio"
            className="mt-1.5 h-4 w-4"
            name={`${fieldPrefix}-grouping`}
            checked={grouping === "color_dir"}
            onChange={() => setGrouping("color_dir")}
          />
          <span>
            <span className="block font-medium">By color, keeping the Source folders</span>
            <span className="block text-meta text-muted-foreground">
              One folder per color, with each Source's own folders inside it.
            </span>
          </span>
        </label>
        <label className="flex min-h-11 items-start gap-2 py-1 text-body">
          <input
            type="radio"
            className="mt-1.5 h-4 w-4"
            name={`${fieldPrefix}-grouping`}
            checked={grouping === "color"}
            onChange={() => setGrouping("color")}
          />
          <span>
            <span className="block font-medium">By color only</span>
            <span className="block text-meta text-muted-foreground">
              One folder per color, with every file flat inside it.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="shop"
          loading={pack.phase === "running"}
          onClick={() => void download()}
        >
          <Download className="mr-1.5 h-4 w-4" aria-hidden />
          Download sorted STL files
        </Button>
        {pack.phase === "running" ? (
          <StatusBadge
            status="in_progress"
            label={job.message || "Collecting the unit files…"}
            live
          />
        ) : null}
      </div>

      {pack.phase === "failed" ? (
        <InlineOperationError
          title="Could not download the STL files"
          message={pack.message}
          onRetry={() => void download()}
          retryLabel="Try again"
        />
      ) : null}

      {pack.phase === "ready" ? (
        <div className="stack-row rounded-md border border-border bg-background p-3">
          <StatusBadge
            status="complete"
            label={`${pack.artifact.fileTotal} file${pack.artifact.fileTotal === 1 ? "" : "s"} ready`}
            live
          />
          {pack.artifact.downloadUrl ? (
            <Button size="shop" variant="outline" className="self-start" asChild>
              <a href={engineAssetUrl(pack.artifact.downloadUrl)} download>
                <Download className="mr-1.5 h-4 w-4" aria-hidden />
                Save the files
              </a>
            </Button>
          ) : pack.artifact.serverPath ? (
            <p className="text-meta text-muted-foreground">
              The files are on the PrintPartner server at{" "}
              <span className="break-all font-mono">{pack.artifact.serverPath}</span>.
            </p>
          ) : null}
          {pack.artifact.warnings.length > 0 ? (
            <div className="rounded-md border border-warning/35 bg-warning-soft p-2.5">
              <p className="text-meta font-medium text-warning">
                {pack.artifact.warnings.length} unit file
                {pack.artifact.warnings.length === 1 ? "" : "s"} could not be included
              </p>
              <ul className="mt-1 list-disc pl-5 text-meta text-warning">
                {pack.artifact.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <p className="text-meta text-muted-foreground">
        Handing over the files ends PrintPartner's part in this production method. These Required units
        stay unverified in Checkoff, because nothing here says a print happened. Once one does, come
        back to Production and choose Add manually prepared prints.
      </p>
    </section>
  );
}
