import { useCallback, useMemo, useState } from "react";
import { isManualIntegrationId, type ProfileSummary } from "@print-partner/contracts";
import type { PrinterCheckoffLink } from "../../api/endpoints/checkoff";
import {
  fetchPrinterCapabilities,
  type PrinterMachine,
} from "../../api/endpoints/printers";
import type { IntegrationSummary } from "../../api/endpoints/integrations";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import InlineOperationError from "./InlineOperationError";
import PrinterCameraView from "./PrinterCameraView";
import PrinterFilesView from "./PrinterFilesView";
import PrinterTrackedView from "./PrinterTrackedView";
import { useAsyncView } from "./asyncView";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  printer: PrinterMachine;
  host: IntegrationSummary | null;
  profiles: ProfileSummary[];
  selectedProfileId: number | null;
  links: PrinterCheckoffLink[];
  onChanged: () => void;
};

const TAB_IDS = ["files", "camera", "tracked"] as const;

type TabId = (typeof TAB_IDS)[number];

/**
 * The beside-the-printer workspace for one printer.
 *
 * Three jobs that change for unrelated reasons, so each one is its own sibling
 * component owning its own fetches: find and assign a print file, look at a
 * camera, and move tracked prints along. This file only routes between them and
 * asks the server what the printer's host can actually serve.
 */
export default function PrinterWorkspaceSheet({
  open,
  onOpenChange,
  printer,
  host,
  profiles,
  selectedProfileId,
  links,
  onChanged,
}: Props) {
  const [tab, setTab] = useState<TabId>("files");
  const [assignedNotice, setAssignedNotice] = useState<string | null>(null);

  const request = useCallback(() => fetchPrinterCapabilities(printer.id), [printer.id]);
  const capabilities = useAsyncView({
    request,
    fallbackMessage: "The server did not answer the capability request.",
  });

  const printerLinks = useMemo(
    () => links.filter((link) => link.printer_id === printer.id),
    [links, printer.id],
  );
  const awaitingOperator = printerLinks.filter(
    (link) =>
      link.state === "watching" && isManualIntegrationId(link.integration_id, printer.id),
  ).length;

  // Both the Files and the Camera tab depend on the same answer, so they show
  // the same waiting line and the same retry rather than two of each.
  const capabilityPending =
    capabilities.view.status === "loading" ? (
      <p className="text-body text-muted-foreground" role="status">
        Checking what {printer.name} can do…
      </p>
    ) : capabilities.view.status === "failed" ? (
      <InlineOperationError
        title={`Could not check what ${printer.name} can do`}
        message={capabilities.view.message}
        onRetry={capabilities.reload}
        retryLabel="Try again"
      />
    ) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{printer.name}</SheetTitle>
          <SheetDescription>
            Find or provide a print file, assign it to a Build, and keep its Checkoff attached.
          </SheetDescription>
        </SheetHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => {
            const next = TAB_IDS.find((id) => id === value);
            if (!next) return;
            if (next === "files") setAssignedNotice(null);
            setTab(next);
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="mx-4 mt-4 grid w-auto grid-cols-3">
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="camera">Camera</TabsTrigger>
            <TabsTrigger value="tracked">
              Tracked{awaitingOperator > 0 ? ` (${awaitingOperator})` : ""}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="files" className="mt-0 p-4">
            {capabilityPending}
            {capabilities.view.status === "ready" ? (
              <PrinterFilesView
                printer={printer}
                host={host}
                canBrowse={capabilities.view.data.files}
                profiles={profiles}
                selectedProfileId={selectedProfileId}
                onAssigned={(link) => {
                  setAssignedNotice(
                    link.units.length > 0
                      ? `${link.filename} is assigned, with ${link.units.length} Required unit${link.units.length === 1 ? "" : "s"} linked.`
                      : `${link.filename} is assigned. No Required unit is linked to it yet.`,
                  );
                  setTab("tracked");
                  onChanged();
                }}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="camera" className="mt-0 p-4">
            {capabilityPending}
            {capabilities.view.status === "ready" ? (
              capabilities.view.data.cameras ? (
                <PrinterCameraView printer={printer} host={host} />
              ) : (
                <p className="rounded-md border border-dashed border-border-strong p-4 text-body text-muted-foreground">
                  {host
                    ? `${host.name} does not serve cameras to PrintPartner. Use the vendor's own app for this printer's camera.`
                    : "Link a printer host in Settings to discover its cameras."}
                </p>
              )
            ) : null}
          </TabsContent>

          <TabsContent value="tracked" className="mt-0 stack-section p-4">
            {assignedNotice ? (
              <p className="text-body text-success" role="status">
                {assignedNotice}
              </p>
            ) : null}
            <PrinterTrackedView
              printer={printer}
              profiles={profiles}
              links={printerLinks}
              onChanged={onChanged}
            />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
