import { Link } from "react-router-dom";
import LayeredSheetMark from "../components/layout/BrandMark";
import { Button } from "../components/ui/button";
import { buildsRoute, helpRoute } from "../lib/routes";

export default function NotFoundPage() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-5 py-16">
      <span className="desk-well h-10 w-10" aria-hidden>
        <LayeredSheetMark className="h-5 w-5" />
      </span>
      <div className="space-y-2">
        <p className="eyebrow">404</p>
        <h1 className="text-page">Page not found</h1>
        <p className="text-body text-muted-foreground">
          This address does not match a page in Print Partner.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="shop" asChild>
          <Link to={buildsRoute()}>Go to Builds</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to={helpRoute()}>Open Help</Link>
        </Button>
      </div>
    </div>
  );
}
