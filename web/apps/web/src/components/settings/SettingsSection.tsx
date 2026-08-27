import type { ReactNode } from "react";

type SettingsSectionProps = {
  id?: string;
  title: string;
  children: ReactNode;
};

export default function SettingsSection({ id, title, children }: SettingsSectionProps) {
  return (
    <section id={id} className="scroll-mt-4 space-y-3">
      <h2 className="text-sm font-semibold tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
