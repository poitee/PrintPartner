import { afterEach } from "vitest";
import { resetSourceSyncAdmissionSession } from "./source-sync-admission.js";

afterEach(() => {
  resetSourceSyncAdmissionSession();
});
