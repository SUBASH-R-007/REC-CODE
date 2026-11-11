-- Phase 7d: the aptitude CSV import, with per-row results.
--
-- SPEC §5: "Reuse the LMS question-bank CSV import/export pipeline with
-- per-row results, so one bad row cannot discard a 300-question file."
--
-- Field for field the ProblemImport / ProblemImportRow shape, and the enums
-- ProblemImportStatus and ProblemImportRowStatus are reused rather than
-- cloned — the shape of the answer is the same. The counter is `revised`,
-- matching the NEW_REVISION row status it counts; a counter named `updated`
-- with no UPDATED status is a counter nobody can reconcile against the rows.
--
-- `defaultArea` and `defaultTopic` are new: an LMS export carries neither, so
-- the operator chooses at upload and the choice is RECORDED with the file. A
-- bank imported under the wrong topic is a weakness heatmap that lies, and
-- the only way to find out which upload did it is to have written it down.

-- ── Display codes ──────────────────────────────────────────────────────
-- A 2,000-row import cannot ask an operator for 2,000 display codes, which
-- is why the CSV's `code` column is optional — so the importer allocates
-- them, and a SEQUENCE is what makes that race-free. `max(displayCode) + 1`
-- read inside a transaction would hand the same code to two concurrent
-- imports and the unique index would refuse the second, failing a whole file
-- for a reason that has nothing to do with its contents.
--
-- Starting at 1,000 so every allocated code is five digits and sorts in a
-- listing; the CHECK already requires at least that many.
CREATE SEQUENCE IF NOT EXISTS "public"."aptitude_display_code_seq" AS BIGINT START WITH 1000 INCREMENT BY 1 NO CYCLE;

-- CreateTable
CREATE TABLE "public"."AptitudeImport" (
    "id" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "status" "public"."ProblemImportStatus" NOT NULL DEFAULT 'PROCESSING',
    "defaultArea" "public"."AptitudeArea",
    "defaultTopic" "public"."AptitudeTopic",
    "total" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "revised" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AptitudeImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AptitudeImportRow" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "status" "public"."ProblemImportRowStatus" NOT NULL,
    "questionId" TEXT,
    "displayCode" TEXT,
    "contentHash" TEXT,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AptitudeImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AptitudeImport_uploadedById_startedAt_idx" ON "public"."AptitudeImport"("uploadedById", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "AptitudeImportRow_importId_line_key" ON "public"."AptitudeImportRow"("importId", "line");

-- AddForeignKey
ALTER TABLE "public"."AptitudeImportRow" ADD CONSTRAINT "AptitudeImportRow_importId_fkey" FOREIGN KEY ("importId") REFERENCES "public"."AptitudeImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Invariants ──────────────────────────────────────────────────────────

ALTER TABLE "public"."AptitudeImport"
  ADD CONSTRAINT "AptitudeImport_counts_check"
  CHECK (
    "total" >= 0
    AND "created" >= 0
    AND "revised" >= 0
    AND "unchanged" >= 0
    AND "failed" >= 0
    AND "created" + "revised" + "unchanged" + "failed" <= "total"
  );

-- The file is a real file: a size, a digest, and a name somebody can match
-- against what they uploaded.
ALTER TABLE "public"."AptitudeImport"
  ADD CONSTRAINT "AptitudeImport_file_check"
  CHECK (
    "sizeBytes" >= 0
    AND "sizeBytes" <= 4194304
    AND char_length(btrim("fileName")) BETWEEN 1 AND 300
    AND "fileSha256" ~ '^[0-9a-f]+$'
    AND char_length("fileSha256") = 64
  );

ALTER TABLE "public"."AptitudeImport"
  ADD CONSTRAINT "AptitudeImport_via_check"
  CHECK ("via" = 'upload' OR "via" LIKE 'cli:%');

-- A finished import carries the moment it finished; one still PROCESSING does
-- not. An import that says DONE with no finish time is an import nobody can
-- put in order.
ALTER TABLE "public"."AptitudeImport"
  ADD CONSTRAINT "AptitudeImport_finished_check"
  CHECK (
    CASE
      WHEN "status" = 'PROCESSING' THEN "finishedAt" IS NULL
      ELSE "finishedAt" IS NOT NULL AND "finishedAt" >= "startedAt"
    END
  );

-- A whole-file failure says why, and only a FAILED import has one. The reason
-- is what an operator reads instead of re-uploading to find out.
ALTER TABLE "public"."AptitudeImport"
  ADD CONSTRAINT "AptitudeImport_error_check"
  CHECK (
    CASE
      WHEN "status" = 'FAILED' THEN "error" IS NOT NULL AND char_length(btrim("error")) >= 5
      ELSE "error" IS NULL
    END
  );

ALTER TABLE "public"."AptitudeImportRow"
  ADD CONSTRAINT "AptitudeImportRow_line_check"
  CHECK ("line" >= 1);

-- A FAILED row says why — every reason, as a non-empty list. A failure with
-- no reason sends an operator back to the file to guess.
ALTER TABLE "public"."AptitudeImportRow"
  ADD CONSTRAINT "AptitudeImportRow_errors_check"
  CHECK (
    jsonb_typeof("errors") = 'array'
    AND jsonb_typeof("warnings") = 'array'
    AND ("status" <> 'FAILED' OR jsonb_array_length("errors") > 0)
    AND ("status" = 'FAILED' OR jsonb_array_length("errors") = 0)
  );

-- A row that applied names the question it applied to; a FAILED one may name
-- the published question it was refused for, and no more.
ALTER TABLE "public"."AptitudeImportRow"
  ADD CONSTRAINT "AptitudeImportRow_applied_check"
  CHECK (
    "status" = 'FAILED'
    OR ("questionId" IS NOT NULL AND "contentHash" IS NOT NULL AND char_length("contentHash") = 64)
  );

-- ── TRUNCATE guards ─────────────────────────────────────────────────────
CREATE TRIGGER "AptitudeImport_no_truncate"
  BEFORE TRUNCATE ON "public"."AptitudeImport"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "AptitudeImportRow_no_truncate"
  BEFORE TRUNCATE ON "public"."AptitudeImportRow"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
