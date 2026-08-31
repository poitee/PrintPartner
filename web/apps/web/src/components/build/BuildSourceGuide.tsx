import { ArrowRight, Library, ListChecks } from "lucide-react";
import { Link } from "react-router-dom";
import { libraryRoute, planRoute } from "../../lib/routes";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";

export default function BuildSourceGuide({ profileId }: { profileId: number }) {
  return (
    <Card
      surface="sunken"
      className="border-primary/40"
      aria-labelledby="build-source-guide-heading"
    >
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="build-source-guide-heading" className="text-sm font-semibold">
              From Source Library to a published Plan
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Sources are reusable projects. This page selects which projects and files belong to
              this Build.
            </p>
          </div>
          <Button size="sm" variant="outline" asChild>
            <Link to={libraryRoute()}>
              <Library className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Manage Source Library
            </Link>
          </Button>
        </div>

        <ol className="grid gap-2 sm:grid-cols-3">
          <li className="rounded-md border border-border bg-card p-3">
            <p className="font-mono text-micro font-semibold uppercase tracking-wide text-primary">
              1 · Library
            </p>
            <p className="mt-1 text-xs font-medium">Add or update the reusable project.</p>
          </li>
          <li className="relative rounded-md border border-border bg-card p-3">
            <ArrowRight
              className="absolute -left-3 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-muted-foreground sm:block"
              aria-hidden
            />
            <p className="font-mono text-micro font-semibold uppercase tracking-wide text-primary">
              2 · This Build
            </p>
            <p className="mt-1 text-xs font-medium">Attach sources, then choose folders or STLs.</p>
          </li>
          <li className="relative rounded-md border border-border bg-card p-3">
            <ArrowRight
              className="absolute -left-3 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-muted-foreground sm:block"
              aria-hidden
            />
            <p className="font-mono text-micro font-semibold uppercase tracking-wide text-primary">
              3 · Plan
            </p>
            <p className="mt-1 text-xs font-medium">Review Required units and publish the revision.</p>
          </li>
        </ol>

        <Button size="sm" variant="ghost" asChild>
          <Link to={planRoute(profileId)}>
            <ListChecks className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Continue to Plan when the files below are ready
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
