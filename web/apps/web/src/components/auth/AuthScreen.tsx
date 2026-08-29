import type { ReactNode } from "react";
import LayeredSheetMark from "../layout/BrandMark";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";

type Props = {
  title: string;
  description?: ReactNode;
  children: ReactNode;
};

/** Shared sign-in door. Login, setup, forgot, and reset all sit on this plate. */
export default function AuthScreen({ title, description, children }: Props) {
  return (
    <main className="desk-canvas flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <div className="flex items-center gap-2.5" aria-hidden>
        <LayeredSheetMark />
        <span className="font-serif text-[17px] font-semibold tracking-[-0.01em] text-foreground">
          Print Partner
        </span>
      </div>
      <Card className="w-full max-w-md shadow-md">
        <CardHeader>
          <CardTitle asChild className="text-page">
            <h1>{title}</h1>
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}

export function AuthField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
