"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Play, Radio } from "lucide-react";
import { Button, Card, CardBody, CardHeader, Field, Select, Textarea, useToast } from "@recx/design";
import { MOCK_FEEDBACK_NOTICE, MOCK_INTERVIEW_LIMITS, MOCK_INTERVIEW_RATINGS, MOCK_INTERVIEW_RATING_LABEL, RATING_MAX, RATING_MIN } from "@recx/shared";
import { finishMockInterview, startMockInterview } from "@/server/actions/mock-interviews";

interface Mirror {
  language: string;
  source: string;
  updatedAt: string;
  candidate: string;
}

/**
 * The interviewer's half of the room (Phase 12h).
 *
 * READ-ONLY, and that is the feature rather than a limitation: SPEC §11
 * contrasts "read-only spectate mode" with collaborative editing, and
 * there is deliberately no way to type into somebody else's editor here.
 * The mirror is a `<pre>`, not a disabled editor — a disabled editor is a
 * control somebody will eventually enable.
 *
 * The stream closes itself when the interview ends, because the server
 * re-checks on every poll rather than once at connect.
 */
export function InterviewerRoom({
  interviewId,
  running,
  problems,
  problemSet,
}: {
  interviewId: string;
  running: boolean;
  problems: Array<{ id: string; displayCode: string; title: string; difficulty: string }>;
  problemSet: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [problemId, setProblemId] = useState("");
  const [pending, startTransition] = useTransition();

  const [mirror, setMirror] = useState<Mirror | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!running) return;
    const source = new EventSource(`/api/mock/${interviewId}/live`);
    source.onopen = () => setLive(true);
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as Mirror | { ended: true };
      if ("ended" in payload) {
        setLive(false);
        source.close();
        router.refresh();
        return;
      }
      setMirror(payload);
    };
    source.onerror = () => setLive(false);
    return () => source.close();
  }, [interviewId, running, router]);

  if (!running) {
    return (
      <Card>
        <CardHeader title="Start the interview" subtitle="Set a problem when you start; the candidate sees it too." />
        <CardBody>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const result = await startMockInterview({ interviewId, problemId: problemId || null });
                if (!result.ok) {
                  toast(result.error, "error");
                  return;
                }
                router.refresh();
              });
            }}
          >
            <Field label="Problem" htmlFor="mock-problem" hint="Optional — you can talk one through instead.">
              <Select id="mock-problem" value={problemId} onChange={(e) => setProblemId(e.target.value)}>
                <option value="">No problem from the catalogue</option>
                {problems.map((problem) => (
                  <option key={problem.id} value={problem.id}>
                    {problem.displayCode} — {problem.title} ({problem.difficulty.toLowerCase()})
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" className="min-h-11" loading={pending}>
              <Play className="h-4 w-4" aria-hidden />
              Start
            </Button>
          </form>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title={mirror ? `${mirror.candidate}'s editor` : "Their editor"}
          subtitle={problemSet ? undefined : "No problem set — you are talking one through."}
          action={
            <span className="flex items-center gap-1.5 text-xs text-text-secondary">
              <Radio className={`h-4 w-4 ${live ? "text-primary" : ""}`} aria-hidden />
              {live ? "Live" : "Reconnecting…"}
            </span>
          }
        />
        <CardBody>
          {mirror && mirror.source ? (
            <>
              <p className="mb-2 text-xs text-muted">
                {mirror.language} · last changed {new Date(mirror.updatedAt).toLocaleTimeString("en-IN")}
              </p>
              {/* Read-only by construction: a <pre>, not a disabled editor. */}
              <pre className="scroll-thin max-h-[28rem] overflow-auto rounded-xl border border-border bg-background p-3 font-mono text-sm">
                {mirror.source}
              </pre>
            </>
          ) : (
            <p className="rounded-xl border border-border bg-background p-4 text-sm text-text-secondary">
              Nothing typed yet. Their editor appears here as they work, a few seconds behind.
            </p>
          )}
        </CardBody>
      </Card>

      <FinishForm interviewId={interviewId} />
    </div>
  );
}

function FinishForm({ interviewId }: { interviewId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [ratings, setRatings] = useState<Record<string, number>>({ communication: 3, problemSolving: 3, code: 3 });
  const [feedbackMd, setFeedback] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      <CardHeader title="Finish and write it up" subtitle={MOCK_FEEDBACK_NOTICE} />
      <CardBody>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const result = await finishMockInterview({
                interviewId,
                communication: ratings.communication!,
                problemSolving: ratings.problemSolving!,
                code: ratings.code!,
                feedbackMd,
              });
              if (!result.ok) {
                toast(result.error, "error");
                return;
              }
              toast("Finished. They can read it now.", "success");
              router.push("/mentor/mock-interviews");
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            {MOCK_INTERVIEW_RATINGS.map((key) => (
              <Field key={key} label={MOCK_INTERVIEW_RATING_LABEL[key]} htmlFor={`rating-${key}`}>
                <Select
                  id={`rating-${key}`}
                  value={String(ratings[key])}
                  onChange={(e) => setRatings((r) => ({ ...r, [key]: Number(e.target.value) }))}
                >
                  {Array.from({ length: RATING_MAX - RATING_MIN + 1 }, (_, i) => RATING_MIN + i).map((n) => (
                    <option key={n} value={n}>
                      {n} / {RATING_MAX}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
          <Field
            label="What should they do differently next time?"
            htmlFor="mock-feedback"
            hint="Markdown. One concrete thing beats five general ones."
          >
            <Textarea
              id="mock-feedback"
              rows={6}
              required
              minLength={MOCK_INTERVIEW_LIMITS.feedback.min}
              maxLength={MOCK_INTERVIEW_LIMITS.feedback.max}
              value={feedbackMd}
              onChange={(e) => setFeedback(e.target.value)}
            />
          </Field>
          <Button type="submit" className="min-h-11" loading={pending}>
            <Check className="h-4 w-4" aria-hidden />
            Finish the interview
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
