export type SettingSnapshot =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "stored"; value: string }>;

export type SettingCompareAndSetInput = Readonly<{
  key: string;
  expected: SettingSnapshot;
  value: string;
}>;

export function settingSnapshotsEqual(
  left: SettingSnapshot,
  right: SettingSnapshot,
): boolean {
  if (left.kind === "missing") return right.kind === "missing";
  return right.kind === "stored" && left.value === right.value;
}
