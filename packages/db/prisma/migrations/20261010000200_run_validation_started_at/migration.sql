-- AlterTable
ALTER TABLE "public"."RunRequest" ADD COLUMN     "startedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."ValidationRun" ADD COLUMN     "startedAt" TIMESTAMP(3);
