import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

/**
 * Catches render errors below it (e.g. a crashing page) and shows a recovery
 * UI instead of white-screening the whole app. Mounted around the route
 * outlet so the nav chrome keeps working; remount it (via `key`) on route
 * changes so navigating away clears the error.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto flex max-w-lg justify-center py-12">
        <Card className="w-full">
          <CardHeader accent>
            <CardTitle asChild>
              <h1 className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
                Something went wrong
              </h1>
            </CardTitle>
            <CardDescription>
              This page hit an unexpected error. Your data is safe — reloading
              usually fixes it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <p className="rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground break-words">
              {this.state.error.message || String(this.state.error)}
            </p>
            <div className="flex gap-2">
              <Button onClick={() => window.location.reload()}>Reload</Button>
              <Button
                variant="secondary"
                onClick={() => this.setState({ error: null })}
              >
                Try again
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}
