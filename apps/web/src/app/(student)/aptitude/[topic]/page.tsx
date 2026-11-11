import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@recx/design";
import { Calculator } from "lucide-react";
import { APTITUDE_AREA_LABEL, APTITUDE_TOPIC_AREA, APTITUDE_TOPIC_LABEL, topicFromSlug } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { nextPracticeQuestion, practiceCountFor, topicProgressFor } from "@/server/queries/aptitude";
import { PracticeQuestionCard } from "@/components/aptitude/practice-question";

export const metadata: Metadata = { title: "Aptitude practice" };

/**
 * `/aptitude/[topic]` — practise one topic (Phase 7e).
 *
 * One question at a time, with the working shown the moment the answer is
 * committed. Fully supported at 375px: reading a question and tapping an
 * option is the one thing a phone is genuinely good at, and the students who
 * most need the aptitude round are the likeliest to be on one. The TIMED
 * multi-section mock is the surface that keeps the 768px floor
 * (`docs/OPEN-QUESTIONS.md`).
 *
 * The topic comes from a kebab-case slug, not the enum spelling:
 * `/aptitude/TIME_SPEED_DISTANCE` in a student's address bar looks like a
 * leaked internal name.
 */
export default async function AptitudeTopicPage({ params }: { params: Promise<{ topic: string }> }) {
  const user = await requireUser();
  const { topic: slug } = await params;
  const topic = topicFromSlug(slug);
  if (!topic) notFound();

  const [question, available, progress] = await Promise.all([
    nextPracticeQuestion({ userId: user.id, topic }),
    practiceCountFor(topic),
    topicProgressFor(user.id),
  ]);
  const mine = progress.find((row) => row.topic === topic);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Link href="/aptitude" className="text-sm text-text-secondary hover:underline">
          ← Aptitude
        </Link>
        <h1 className="font-display text-2xl font-bold tracking-tight">{APTITUDE_TOPIC_LABEL[topic]}</h1>
        <p className="text-sm text-text-secondary">
          {APTITUDE_AREA_LABEL[APTITUDE_TOPIC_AREA[topic]]} · {available} question{available === 1 ? "" : "s"}
          {mine && mine.attempted > 0 ? (
            <>
              {" · "}
              you have answered {mine.attempted} and got {mine.correct} right
              {mine.accuracyPercent !== null ? ` (${mine.accuracyPercent}%)` : ""}
            </>
          ) : null}
        </p>
      </header>

      {question === null ? (
        <EmptyState
          icon={<Calculator aria-hidden="true" />}
          title="Nothing here yet"
          description="No questions have been published for this topic. Nothing you did caused this — try another topic while the bank is written."
        />
      ) : (
        <PracticeQuestionCard
          topicLabel={APTITUDE_TOPIC_LABEL[topic]}
          question={{
            id: question.id,
            displayCode: question.displayCode,
            kind: question.kind,
            stem: question.stem,
            options: question.options,
            numericUnit: question.numericUnit,
            expectedSeconds: question.expectedSeconds,
            passage: question.passage ? { title: question.passage.title, body: question.passage.body } : null,
          }}
        />
      )}
    </div>
  );
}
