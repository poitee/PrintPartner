import { Link } from "react-router-dom";
import { Button } from "../components/ui/button";
import { buildsRoute, helpRoute } from "../lib/routes";

export default function NotFoundPage() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-4 py-12">
      <div className="space-y-2">
        <p className="font-mono text-sm text-muted-foreground">404</p>
        <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          This address does not match a page in Print Partner.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link to={buildsRoute()}>Go to Builds</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to={helpRoute()}>Open Help</Link>
        </Button>
      </div>
    </div>
  );
}
