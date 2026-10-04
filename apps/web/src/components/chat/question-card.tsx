import { MessageCircleQuestionIcon } from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { QuestionRequest } from "@cloud-swe/api/contracts";

import { ThreadApiError } from "@cloud-swe/api/client";
import { messageForError } from "@/lib/submission-errors";

/** A questionnaire answer is text; a file or missing field is not an answer. */
const answerSchema = z.string().trim().min(1).max(10_000);

export function QuestionSummary({ request }: { request: QuestionRequest }) {
  return (
    <section
      aria-label="Question answers"
      className="flex flex-col gap-2 rounded-xl border border-border/60 p-3"
    >
      <p className="text-sm font-medium">
        {request.state === "cancelled" ? "Question cancelled" : "Answers accepted"}
      </p>
      <dl className="flex flex-col gap-2 text-sm">
        {request.questions.map((question) => (
          <div key={question.id}>
            <dt className="text-muted-foreground">{question.question}</dt>
            <dd className="whitespace-pre-wrap">
              {request.answers?.[question.id] ?? "No answer submitted."}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * A pending question request blocks the run, so its answers are submitted as one
 * durable answer set rather than as a normal prompt.
 */
/* oxlint-disable anti-slop/no-unknown-parameters -- Mutation errors cross a transport boundary; instanceof is the only safe check. */
/** A conflict means the durable answer already exists; resending cannot help. */
function conflict(error: unknown): boolean {
  return error instanceof ThreadApiError && error.status === 409;
}

export function QuestionCard({
  request,
  onAnswer,
  pending,
  error,
}: {
  request: QuestionRequest;
  onAnswer: (answers: Record<string, string>) => void;
  pending: boolean;
  error: unknown;
}) {
  const [invalid, setInvalid] = useState(false);
  const [retry, setRetry] = useState<Record<string, string> | null>(null);

  const locked = pending || retry !== null;

  const items = request.questions.map((question) => ({
    name: question.id,
    required: true,
    choices: question.choices?.map((choice) => ({ value: choice.label, disabled: locked })),
  }));

  if (request.state !== "pending") return <QuestionSummary request={request} />;

  return (
    <div className="flex w-full flex-col gap-3 rounded-2xl border border-border/60 bg-card/40 p-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <MessageCircleQuestionIcon className="size-4" />
        The agent needs an answer to continue
      </p>
      <Questionnaire
        className="gap-5"
        aria-busy={pending}
        items={items}
        onSubmit={(event) => {
          event.preventDefault();

          if (locked) return;
          const data = new FormData(event.currentTarget);
          const answers: Record<string, string> = {};

          for (const question of request.questions) {
            const value = answerSchema.safeParse(data.get(question.id));

            if (value.success) answers[question.id] = value.data;
          }

          if (Object.keys(answers).length !== request.questions.length) {
            setInvalid(true);

            return;
          }

          setInvalid(false);
          setRetry(answers);
          onAnswer(answers);
        }}
        shortcuts="letters"
      >
        <QuestionnaireProgress />
        {request.questions.map((question) => (
          <QuestionnaireItem invalid={invalid} key={question.id} name={question.id} required>
            <QuestionnaireTitle>{question.question}</QuestionnaireTitle>
            <QuestionnaireDescription>{question.header}</QuestionnaireDescription>
            <QuestionnaireChoices>
              {question.choices?.map((choice) => (
                <QuestionnaireChoice disabled={locked} key={choice.label} value={choice.label}>
                  {choice.label}
                  <QuestionnaireChoiceDescription>
                    {choice.description}
                  </QuestionnaireChoiceDescription>
                </QuestionnaireChoice>
              ))}
              <QuestionnaireInput
                disabled={locked}
                aria-label={`${question.question} Write your answer`}
                placeholder="Type your answer"
                maxLength={10_000}
              />
            </QuestionnaireChoices>
          </QuestionnaireItem>
        ))}
        <QuestionnaireActions>
          <QuestionnairePrevious disabled={locked} />
          <QuestionnaireNext disabled={locked} />
          <QuestionnaireSubmit disabled={locked}>
            {pending ? <Spinner className="size-4" /> : null}
            Send answers
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
      {invalid ? (
        <p className="text-xs text-destructive">Answer every question before sending.</p>
      ) : null}
      {error ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-destructive">{messageForError(error)}</p>
          {retry && conflict(error) ? (
            <p className="text-xs text-muted-foreground">
              Question state changed. Checking the committed answer instead of resending it.
            </p>
          ) : null}
          {retry && !conflict(error) ? (
            <Button
              className="self-start"
              disabled={pending}
              onClick={() => onAnswer(retry)}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry these answers
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
