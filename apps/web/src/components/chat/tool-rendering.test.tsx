/// <reference types="bun" />
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UserMessage } from "./user-message";
import Markdown from "./rich-markdown";
import ToolPatch from "./tool-patch";
import { QuestionCard, QuestionSummary } from "./question-card";
import type { QuestionRequest } from "@cloud-swe/api/contracts";

const question: QuestionRequest = {
  id: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  threadId: "33333333-3333-4333-8333-333333333333",
  toolCallId: "ask",
  browserHandoff: false,
  state: "pending",
  answers: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  answeredAt: null,
  cancelledAt: null,
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which scope?",
      choices: [
        { label: "Small", description: "One file" },
        { label: "Large", description: "All files" },
      ],
    },
  ],
};

test("questions offer free text beside choices and settled answers are read-only", () => {
  const pending = renderToStaticMarkup(
    <QuestionCard request={question} pending={false} error={null} onAnswer={() => undefined} />,
  );

  expect(pending).toContain('type="radio"');
  expect(pending).toContain('aria-label="Which scope? Write your answer"');

  const answered = renderToStaticMarkup(
    <QuestionSummary
      request={{ ...question, state: "answered", answers: { scope: "Custom answer" } }}
    />,
  );

  expect(answered).toContain("Custom answer");
  expect(answered).not.toContain("<input");
  expect(answered).not.toContain("<button");
});

test("malformed and truncated patches render escaped text rather than crashing Pierre", () => {
  const patch = "<script>alert(1)</script>\n@@ broken diff";

  for (const truncated of [true, false]) {
    const html = renderToStaticMarkup(<ToolPatch patch={patch} truncated={truncated} />);
    expect(html).toContain(truncated ? "Truncated diff" : "Invalid diff");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  }
});

test("Markdown blocks raw HTML, unsafe links and automatic remote images", () => {
  const html = renderToStaticMarkup(
    <Markdown>
      {
        '[safe](https://example.com)\n\n[unsafe](javascript:alert)\n\n![tracker](https://tracker.example/pixel.png)\n\n<script>alert(1)</script>\n<img src="https://tracker.example/html.png">'
      }
    </Markdown>,
  );

  expect(html).toContain('href="https://example.com/"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script");
  expect(html).not.toContain('rel="preload"');
});

test("browser handoffs offer the live browser and handback without a chat input", () => {
  const html = renderToStaticMarkup(
    <QuestionCard
      request={{
        ...question,
        browserHandoff: true,
        questions: [{ id: "browser", header: "Browser", question: "Sign in to GitHub." }],
      }}
      pending={false}
      error={null}
      onAnswer={() => undefined}
      onOpenBrowser={() => undefined}
    />,
  );

  expect(html).toContain("Sign in to GitHub.");
  expect(html).toContain("Open browser");
  expect(html).toContain("Done, hand back");
  expect(html).not.toContain("<input");
});

test("sent user prompts highlight file and skill tokens and escape their text", () => {
  const html = renderToStaticMarkup(
    <UserMessage
      attachments={[]}
      delivery="sent"
      text="Read @src/app.ts with $browser and user@example.com <script>"
    />,
  );

  expect(html.match(/<mark /g)?.length).toBe(2);
  expect(html).toContain("@src/app.ts</mark>");
  expect(html).toContain("$browser</mark>");
  expect(html).toContain("user@example.com");
  expect(html).not.toContain("<script>");
});
