import { describe, expect, it } from "vitest";
import {
  buildRoute,
  buildSourcesRoute,
  buildsRoute,
  checkoffRoute,
  exportRoute,
  isBuildPath,
  isBuildsPath,
  isCheckoffPath,
  isExportPath,
  isKitStudioPath,
  isLibraryPath,
  isPartsPath,
  isPlanPath,
  isPlansPath,
  isPlanWorkflowPath,
  isProgressPath,
  isReviewPath,
  libraryRoute,
  partsRoute,
  planRoute,
  plansRoute,
  planStudioRoute,
  productionRoute,
  prepareMissingPartsRoute,
  progressRoute,
  reviewRoute,
  withProfile,
} from "./routes";

describe("withProfile", () => {
  it("appends profile query when id is set", () => {
    expect(withProfile("/plate", 42)).toBe("/plate?profile=42");
  });

  it("leaves path unchanged when id is null", () => {
    expect(withProfile("/plate", null)).toBe("/plate");
  });

  it("uses ampersand when path already has query", () => {
    expect(withProfile("/plate?foo=1", 3)).toBe("/plate?foo=1&profile=3");
  });
});

describe("planStudioRoute", () => {
  it("redirects legacy studio links to plan", () => {
    expect(planStudioRoute(7)).toBe("/sources?profile=7");
  });
});

describe("workflow routes", () => {
  it("canonical helpers include profile when provided", () => {
    expect(libraryRoute()).toBe("/library");
    expect(buildSourcesRoute(5)).toBe("/sources?profile=5");
    expect(planRoute(5)).toBe("/plan?profile=5");
    expect(partsRoute(5)).toBe("/plan?profile=5");
    expect(progressRoute(5)).toBe("/progress?profile=5");
    expect(productionRoute(5)).toBe("/export?profile=5");
    expect(prepareMissingPartsRoute(5)).toBe("/export?profile=5&select=missing");
    expect(exportRoute(5)).toBe("/export?profile=5");
    expect(buildsRoute(5)).toBe("/builds?profile=5");
    expect(plansRoute(5)).toBe("/builds?profile=5");
  });

  it("legacy aliases point at canonical paths", () => {
    expect(buildRoute(5)).toBe("/sources?profile=5");
    expect(reviewRoute(5)).toBe("/plan?profile=5");
    expect(checkoffRoute(5)).toBe("/progress?profile=5");
    expect(checkoffRoute(null)).toBe("/progress");
  });
});

describe("path matchers", () => {
  it("detects kit studio paths", () => {
    expect(isKitStudioPath("/plans/12/studio")).toBe(true);
    expect(isKitStudioPath("/build")).toBe(false);
  });

  it("detects stage paths including legacy aliases", () => {
    expect(isLibraryPath("/library")).toBe(true);
    expect(isLibraryPath("/sources")).toBe(false);
    expect(isBuildPath("/sources")).toBe(true);
    expect(isBuildPath("/build")).toBe(true);
    expect(isBuildPath("/plan")).toBe(false);
    expect(isPlanPath("/plan")).toBe(true);
    expect(isPlanPath("/parts")).toBe(true);
    expect(isPlanPath("/review")).toBe(true);
    expect(isPlanPath("/sources")).toBe(false);
    expect(isBuildsPath("/builds")).toBe(true);
    expect(isBuildsPath("/plans")).toBe(true);
    expect(isPlansPath("/plans")).toBe(true);
    expect(isPlansPath("/builds")).toBe(true);
    expect(isPlansPath("/plan")).toBe(false);
    expect(isPartsPath("/parts")).toBe(true);
    expect(isPartsPath("/review")).toBe(true);
    expect(isPartsPath("/plan")).toBe(true);
    expect(isProgressPath("/progress")).toBe(true);
    expect(isProgressPath("/checkoff")).toBe(true);
    expect(isExportPath("/export")).toBe(true);
    expect(isExportPath("/production")).toBe(false);
    expect(isReviewPath("/review")).toBe(true);
    expect(isReviewPath("/parts")).toBe(true);
    expect(isReviewPath("/checkoff")).toBe(true);
    expect(isReviewPath("/progress")).toBe(true);
    expect(isCheckoffPath("/checkoff")).toBe(true);
    expect(isCheckoffPath("/progress")).toBe(true);
    expect(isCheckoffPath("/review")).toBe(false);
  });

  it("detects plan workflow paths", () => {
    expect(isPlanWorkflowPath("/sources")).toBe(true);
    expect(isPlanWorkflowPath("/library")).toBe(true);
    expect(isPlanWorkflowPath("/build")).toBe(true);
    expect(isPlanWorkflowPath("/builds")).toBe(true);
    expect(isPlanWorkflowPath("/plans")).toBe(true);
    expect(isPlanWorkflowPath("/plan")).toBe(true);
    expect(isPlanWorkflowPath("/parts")).toBe(true);
    expect(isPlanWorkflowPath("/progress")).toBe(true);
    expect(isPlanWorkflowPath("/export")).toBe(true);
    expect(isPlanWorkflowPath("/production")).toBe(false);
    expect(isPlanWorkflowPath("/review")).toBe(true);
    expect(isPlanWorkflowPath("/checkoff")).toBe(true);
    expect(isPlanWorkflowPath("/plans/3/studio")).toBe(true);
    expect(isPlanWorkflowPath("/plate")).toBe(false);
  });
});
