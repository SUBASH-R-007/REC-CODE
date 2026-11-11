-- Phase 9e: the placement export's own record.
--
-- SPEC §5 wants the cohort dashboard to produce a CSV of the declared column
-- set. This table is the half of that which is not the file: who asked, when,
-- with which filters, which columns, how many rows, and the digest of what
-- they were given.
--
-- Why it exists at all, said plainly: a CSV of five thousand students'
-- readiness is the most portable thing this platform can produce, and a
-- leaked one has to be attributable to a PERSON rather than to "the
-- dashboard". The file's own first line names this row's id, so the file and
-- the record point at each other.
--
-- `sha256` is of the file as sent. It is not integrity protection — anybody
-- holding the file can recompute it — it is identification: given a
-- spreadsheet somebody forwarded, the digest says which export it came from
-- and therefore who asked for it.
--
-- Append-only, by trigger. An export record that could be edited after the
-- fact would be a record of nothing.

-- CreateTable
CREATE TABLE "public"."PlacementExport" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The cohort filter the officer chose, as given. Stored so a dispute
    -- about "who was in that file" is answerable without re-running a query
    -- against a cohort that has since changed.
    "filters" JSONB NOT NULL DEFAULT '{}',
    "columns" TEXT[],
    "rowCount" INTEGER NOT NULL,
    -- The campus day of the readiness run the figures came from. Null when
    -- no run had finished, which is a file of identity columns only.
    "computedOn" DATE,
    "sha256" TEXT NOT NULL,

    CONSTRAINT "PlacementExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlacementExport_requestedById_requestedAt_idx" ON "public"."PlacementExport"("requestedById", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "PlacementExport_requestedAt_idx" ON "public"."PlacementExport"("requestedAt" DESC);

-- AddForeignKey
-- RESTRICT: the record of who exported a cohort outlives the convenience of
-- deleting a staff account. A staff member who leaves is deactivated, not
-- removed, exactly as everywhere else in this schema.
ALTER TABLE "public"."PlacementExport" ADD CONSTRAINT "PlacementExport_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Invariants ──────────────────────────────────────────────────────────

-- A file with no columns is not a file anybody asked for, and a row count
-- below zero is a bug rather than an empty export.
--
-- COALESCE'd, and this is not defensive noise: `array_length('{}', 1)` is
-- NULL, not 0, and a CHECK that evaluates to NULL is SATISFIED. Written
-- without it, the constraint accepted the exact row it exists to refuse. The
-- fifth time that trap has been sprung in this schema, and the fifth time an
-- invariant test found it rather than a review.
ALTER TABLE "public"."PlacementExport"
  ADD CONSTRAINT "PlacementExport_columns_check"
  CHECK (COALESCE(array_length("columns", 1), 0) >= 1 AND "rowCount" >= 0);

-- A sha256 is 64 hex characters. Checked because a truncated or placeholder
-- digest identifies nothing, and a column that sometimes holds one and
-- sometimes holds "pending" is worse than no column.
ALTER TABLE "public"."PlacementExport"
  ADD CONSTRAINT "PlacementExport_sha256_check"
  CHECK ("sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "public"."PlacementExport"
  ADD CONSTRAINT "PlacementExport_filters_object"
  CHECK (jsonb_typeof("filters") = 'object');

-- ── Guards ──────────────────────────────────────────────────────────────

-- Append-only. An export record that could be edited after the fact would be
-- a record of nothing, and one that could be deleted would let the person who
-- exported a cohort remove the evidence that they did.
CREATE OR REPLACE FUNCTION recx_refuse_placement_export_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PlacementExport_append_only: an export record is never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'PlacementExport_append_only: an export record is never edited'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PlacementExport_append_only"
  BEFORE UPDATE OR DELETE ON "public"."PlacementExport"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_placement_export_change();

CREATE TRIGGER "PlacementExport_no_truncate"
  BEFORE TRUNCATE ON "public"."PlacementExport"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

-- The index the section heatmap reads. `ReadinessSnapshot` already has
-- (computedOn, departmentCode, batchYear, section); the heatmap groups by
-- section alone across a whole run, which that index serves only as a prefix
-- scan over the department. One more, so the grid is one index scan rather
-- than a sequential pass over a year of snapshots.
CREATE INDEX "ReadinessSnapshot_computedOn_section_idx" ON "public"."ReadinessSnapshot"("computedOn", "section");
