import type Database from "better-sqlite3";

export const SOURCE_REVISION_TENANT_REPAIR_STATEMENTS = [
  `DELETE FROM source_revisions
    WHERE NOT EXISTS (
        SELECT 1 FROM projects active_pointer
         WHERE active_pointer.current_source_revision_id = source_revisions.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM plan_revision_inputs accepted_input
         WHERE accepted_input.source_revision_id = source_revisions.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM plan_draft_inputs draft_input
         WHERE draft_input.source_revision_id = source_revisions.id
      )
      AND EXISTS (
        SELECT 1
          FROM projects owner
          JOIN source_revisions active_revision
            ON active_revision.id = owner.current_source_revision_id
           AND active_revision.project_id = owner.id
           AND active_revision.tenant_id <> owner.tenant_id
         WHERE owner.id = source_revisions.project_id
           AND source_revisions.id <> active_revision.id
           AND source_revisions.tenant_id = owner.tenant_id
           AND source_revisions.upstream_revision_key =
             active_revision.upstream_revision_key
      )`,
  `UPDATE projects
    SET current_source_revision_id = (
      SELECT owned_revision.id
        FROM source_revisions active_revision
        JOIN source_revisions owned_revision
          ON owned_revision.project_id = active_revision.project_id
         AND owned_revision.id <> active_revision.id
         AND owned_revision.upstream_revision_key =
           active_revision.upstream_revision_key
         AND owned_revision.manifest_digest = active_revision.manifest_digest
         AND owned_revision.snapshot_locator = active_revision.snapshot_locator
         AND owned_revision.completeness = active_revision.completeness
       WHERE active_revision.id = projects.current_source_revision_id
         AND active_revision.project_id = projects.id
         AND active_revision.tenant_id <> projects.tenant_id
         AND owned_revision.tenant_id = projects.tenant_id
       LIMIT 1
    )
    WHERE EXISTS (
      SELECT 1
        FROM source_revisions active_revision
        JOIN source_revisions owned_revision
          ON owned_revision.project_id = active_revision.project_id
         AND owned_revision.id <> active_revision.id
         AND owned_revision.upstream_revision_key =
           active_revision.upstream_revision_key
         AND owned_revision.manifest_digest = active_revision.manifest_digest
         AND owned_revision.snapshot_locator = active_revision.snapshot_locator
         AND owned_revision.completeness = active_revision.completeness
       WHERE active_revision.id = projects.current_source_revision_id
         AND active_revision.project_id = projects.id
         AND active_revision.tenant_id <> projects.tenant_id
         AND owned_revision.tenant_id = projects.tenant_id
    )`,
  `UPDATE source_revisions
    SET tenant_id = (
      SELECT owner.tenant_id
        FROM projects owner
       WHERE owner.id = source_revisions.project_id
         AND owner.current_source_revision_id = source_revisions.id
    )
    WHERE EXISTS (
      SELECT 1
        FROM projects owner
       WHERE owner.id = source_revisions.project_id
         AND owner.current_source_revision_id = source_revisions.id
         AND owner.tenant_id <> source_revisions.tenant_id
    )
      AND NOT EXISTS (
        SELECT 1
          FROM source_revisions owned_revision
          JOIN projects owner ON owner.id = source_revisions.project_id
         WHERE owned_revision.id <> source_revisions.id
           AND owned_revision.project_id = source_revisions.project_id
           AND owned_revision.tenant_id = owner.tenant_id
           AND owned_revision.upstream_revision_key = source_revisions.upstream_revision_key
      )`,
] as const;

export const STRANDED_SOURCE_REVISION_QUERY = `SELECT revision.id,
    revision.project_id,
    revision.tenant_id AS revision_tenant_id,
    project.tenant_id AS project_tenant_id,
    revision.upstream_revision_key
  FROM source_revisions revision
  JOIN projects project
    ON project.id = revision.project_id
   AND project.current_source_revision_id = revision.id
  WHERE revision.tenant_id <> project.tenant_id
  ORDER BY revision.id
  LIMIT 1`;

export type StrandedSourceRevision = Readonly<{
  id: number;
  project_id: number;
  revision_tenant_id: string;
  project_tenant_id: string;
  upstream_revision_key: string;
}>;

export function strandedSourceRevisionError(
  revision: StrandedSourceRevision,
): Error {
  return new Error(
    `Active Source revision ${revision.id} for Source ${revision.project_id} cannot be ` +
      `moved from tenant ${revision.revision_tenant_id} to ` +
      `${revision.project_tenant_id} without conflicting with protected history; ` +
      "manual recovery is required",
  );
}

function requireNoStrandedRevision(
  revision: StrandedSourceRevision | undefined,
): void {
  if (revision) throw strandedSourceRevisionError(revision);
}

export function repairSourceRevisionTenantOwnershipSqlite(
  sqlite: Database.Database,
  dependencies: {
    afterStatements?: () => void;
  } = {},
): void {
  const repair = sqlite.transaction(() => {
    for (const statement of SOURCE_REVISION_TENANT_REPAIR_STATEMENTS) {
      sqlite.exec(statement);
    }
    dependencies.afterStatements?.();
    requireNoStrandedRevision(
      sqlite.prepare(STRANDED_SOURCE_REVISION_QUERY).get() as
        | StrandedSourceRevision
        | undefined,
    );
  });
  repair.immediate();
}

type PostgresMigrationClient = {
  query(sql: string): Promise<{ rows: unknown[] }>;
};

export async function repairSourceRevisionTenantOwnershipPostgres(
  client: PostgresMigrationClient,
): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of SOURCE_REVISION_TENANT_REPAIR_STATEMENTS) {
      await client.query(statement);
    }
    const result = await client.query(STRANDED_SOURCE_REVISION_QUERY);
    requireNoStrandedRevision(
      result.rows[0] as StrandedSourceRevision | undefined,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
