import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemePreference } from "../context/ThemeContext";
import { SegmentedControl } from "./ui/segmented-control";

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

type Props = {
  className?: string;
  /** Compact labels for sidebar */
  compact?: boolean;
};

export default function ThemePreferenceControl({ className, compact }: Props) {
  const { preference, setPreference } = useTheme();

  return (
    <SegmentedControl
      className={className}
      value={preference}
      onValueChange={setPreference}
      aria-label="Theme"
      options={OPTIONS.map(({ value, label, icon: Icon }) => ({
        value,
        label: compact ? undefined : label,
        icon: <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />,
        title: label,
      }))}
    />
  );
}
