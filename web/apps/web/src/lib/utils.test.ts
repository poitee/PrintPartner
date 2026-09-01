import { describe, expect, it } from "vitest";
import { cn } from "./utils";

const TYPE_SCALE = ["micro", "meta", "body", "lead", "title", "section", "page"] as const;

describe("cn", () => {
  it.each(TYPE_SCALE)("keeps text-%s when a colour class follows", (size) => {
    expect(cn(`text-${size} text-muted-foreground`)).toBe(`text-${size} text-muted-foreground`);
  });

  it.each(TYPE_SCALE)("keeps text-%s when a status colour follows", (size) => {
    expect(cn(`text-${size} text-destructive`)).toBe(`text-${size} text-destructive`);
  });

  it("still lets a later size win over an earlier one", () => {
    expect(cn("text-body text-title")).toBe("text-title");
    expect(cn("text-sm text-body")).toBe("text-body");
    expect(cn("text-body text-sm")).toBe("text-sm");
  });

  it("still lets a later colour win over an earlier one", () => {
    expect(cn("text-muted-foreground text-destructive")).toBe("text-destructive");
  });

  it("keeps the deprecated micro aliases working during the migration", () => {
    expect(cn("text-2xs text-muted-foreground")).toBe("text-2xs text-muted-foreground");
    expect(cn("text-3xs text-muted-foreground")).toBe("text-3xs text-muted-foreground");
  });
});
