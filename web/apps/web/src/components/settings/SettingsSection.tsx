import type { ReactNode } from "react";

type SettingsSectionProps = {
  id?: string;
  title: string;
  children: ReactNode;
};

export default function SettingsSection({ id, title, children }: SettingsSectionProps) {
  return (
    <section id={id} className="scroll-mt-4 stack-section">
      <h2 className="section-heading">{title}</h2>
      <div className="stack-section">{children}</div>
    </section>
  );
}
