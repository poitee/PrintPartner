import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { statusTone } from "../../lib/statusTone";
import {
  workPackageStatusOwner,
  workPackageStatusTone,
  type WorkPackage,
} from "../../lib/workPackageProjection";
import { cn } from "@/lib/utils";

type Props = Readonly<{
  pkg: WorkPackage;
  /** Task list and panels for the package being prepared. */
  children?: ReactNode;
  /** Extra controls in the header row. */
  actions?: ReactNode;
  className?: string;
}>;

function factLine(pkg: WorkPackage): string[] {
  const facts: string[] = [];
  const links = pkg.links;
  if (links.acceptedPlan) facts.push(`Plan revision ${links.acceptedPlan.version} accepted`);
  if (links.plateRevision) facts.push(`Plate revision ${links.plateRevision.number}`);
  if (pkg.unitCount > 0) {
    facts.push(`${pkg.unitCount} Required ${pkg.unitCount === 1 ? "unit" : "units"}`);
  }
  if (pkg.plateCount > 0) {
    facts.push(`${pkg.plateCount} ${pkg.plateCount === 1 ? "Plate" : "Plates"}`);
  }
  if (links.exportArtifact) {
    facts.push(`Exported ${links.exportArtifact.plateCount} 3MF`);
  }
  if (links.slicedFile) facts.push(links.slicedFile.name);
  if (links.printer) facts.push(links.printer.name);
  return facts;
}

/**
 * One Production work package: what it makes, one status from the fixed set,
 * and the records it is tied to. The status text always sits beside the colour,
 * so colour never carries the meaning alone.
 */
export default function WorkPackageCard({ pkg, children, actions, className }: Props) {
  const facts = factLine(pkg);
  const tone = workPackageStatusTone(pkg.status);

  return (
    <section
      className={cn("rounded-lg border border-border bg-card", className)}
      aria-label={`${pkg.title} · ${pkg.statusLabel}`}
    >
      <div className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-foreground">{pkg.title}</h2>
            <span
              className={cn(
                "shrink-0 rounded-md px-2 py-0.5 text-xs font-medium",
                statusTone({ tone, emphasis: "soft" }),
              )}
            >
              {pkg.statusLabel}
            </span>
            <span className="text-xs text-muted-foreground">
              {workPackageStatusOwner(pkg.status)}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{pkg.summary}</p>
          {facts.length > 0 ? (
            <p className="mt-1 font-mono text-micro text-muted-foreground">{facts.join(" · ")}</p>
          ) : null}
          {pkg.blockedReason ? (
            <p className="mt-1 text-xs text-muted-foreground">{pkg.blockedReason}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
        {pkg.links.verification ? (
          <Link
            className="shrink-0 self-center rounded-md border border-border px-3 py-2 text-xs font-medium underline-offset-2 hover:bg-accent/60"
            to={pkg.links.verification.route}
          >
            {pkg.status === "needs_verification" ? "Verify in Checkoff" : "Open Checkoff"}
          </Link>
        ) : null}
      </div>
      {children ? <div className="space-y-3 px-4 py-3">{children}</div> : null}
    </section>
  );
}
