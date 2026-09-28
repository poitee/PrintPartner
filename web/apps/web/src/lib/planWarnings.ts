import type { ProfileSummary, } from "@print-partner/contracts";

export function planHeaderSubtitle(input: {
  profile: ProfileSummary | undefined;
  sourceCount: number;
  partCount: number;
}): string {
  const name = input.profile?.name?.trim();
  const bits: string[] = [];
  if (name) bits.push(name);
  if (input.sourceCount > 0) {
    bits.push(`${input.sourceCount} source${input.sourceCount === 1 ? "" : "s"}`);
  }
  if (input.partCount > 0) {
    bits.push(`${input.partCount} part${input.partCount === 1 ? "" : "s"}`);
  }
  return bits.join(" · ") || "Attach sources, pick files, set role colors.";
}
