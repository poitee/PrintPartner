import { useState } from "react";
import { FileCode2 } from "lucide-react";
import { isManualIntegrationId, type ProfileSummary } from "@print-partner/contracts";
import {
  completeManualPrinterFile,
  type PrinterCheckoffLink,
} from "../../api/endpoints/checkoff";
import type { PrinterMachine } from "../../api/endpoints/printers";
import { Button } from "../ui/button";
import { StatusBadge } from "../ui/status-badge";
import InlineOperationError from "./InlineOperationError";
import { failureMessage } from "./asyncView";
import { trackedPrintPresentation } from "./trackedPrintPresentation";

type Props = {
  printer: PrinterMachine;
  profiles: ProfileSummary[];
  links: PrinterCheckoffLink[];
  onChanged: () => void;
};

/**
 * Every print file assigned to this printer, and the one action each one needs.
 *
 * Split out of the workspace sheet because it changes for Checkoff reasons.
 */
type FinishState =
  | { phase: "idle" }
  | { phase: "finishing"; linkId: string }
  | { phase: "failed"; linkId: string; message: string };

export default function PrinterTrackedView({ printer, profiles, links, onChanged }: Props) {
  const [finish, setFinish] = useState<FinishState>({ phase: "idle" });

  const finishManual = async (link: PrinterCheckoffLink) => {
    setFinish({ phase: "finishing", linkId: link.id });
    try {
      await completeManualPrinterFile(link.id);
      setFinish({ phase: "idle" });
      onChanged();
    } catch (error) {
      setFinish({
        phase: "failed",
        linkId: link.id,
        message: failureMessage(error, "The server did not accept the finish."),
      });
    }
  };

  if (links.length === 0) {
    return (
      <div className="stack-row rounded-md border border-dashed border-border-strong p-4">
        <p className="text-body text-muted-foreground">
          No print file is assigned to {printer.name} yet.
        </p>
        <p className="text-meta text-muted-foreground">
          Pick a file in the Files tab and assign it to a Build. Its Checkoff stays attached to it.
        </p>
      </div>
    );
  }

  return (
    <ul className="stack-row">
      {links.map((link) => {
        const manual = isManualIntegrationId(link.integration_id, printer.id);
        const presentation = trackedPrintPresentation({ state: link.state, manual });
        const buildName =
          profiles.find((profile) => profile.id === link.profile_id)?.name ??
          `Build ${link.profile_id}`;
        const finishing = finish.phase === "finishing" && finish.linkId === link.id;

        return (
          <li key={link.id} className="stack-row rounded-md border border-border p-3">
            <div className="flex flex-wrap items-start gap-3">
              <FileCode2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-body font-medium" title={link.filename}>
                  {link.filename}
                </p>
                <p className="text-meta text-muted-foreground">
                  {buildName}
                  {" · "}
                  <span className="tabular">{link.units.length}</span> Required unit
                  {link.units.length === 1 ? "" : "s"}
                </p>
                <StatusBadge
                  className="mt-1.5"
                  status={presentation.status}
                  label={presentation.label}
                  size="sm"
                />
              </div>
              {manual && link.state === "watching" ? (
                <Button
                  size="shop"
                  loading={finishing}
                  onClick={() => void finishManual(link)}
                >
                  {finishing ? "Finishing…" : "Mark finished"}
                </Button>
              ) : null}
            </div>
            {finish.phase === "failed" && finish.linkId === link.id ? (
              <InlineOperationError
                title={`Could not finish ${link.filename}`}
                message={finish.message}
                onRetry={() => void finishManual(link)}
                retryLabel="Mark finished again"
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
