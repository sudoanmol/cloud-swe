import { AttachmentGroup } from "@/components/ui/attachment";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import { Spinner } from "@/components/ui/spinner";
import type { PublicAttachmentMetadata } from "@cloud-swe/api/contracts";
import type { Delivery } from "@/lib/chat-types";
import { AttachmentPreview } from "./attachment-preview";

/** A user prompt, shown from the moment it is sent, before the server answers. */
export function UserMessage({
  attachments,
  delivery,
  text,
}: {
  attachments: readonly PublicAttachmentMetadata[];
  delivery: Delivery;
  text: string;
}) {
  return (
    <Message align="end" className="animate-[fade-up_0.25s_cubic-bezier(0.22,1,0.36,1)]">
      <MessageContent className="items-end gap-2">
        {attachments.length > 0 ? (
          <AttachmentGroup aria-label="Attachments" role="group" tabIndex={0}>
            {attachments.map((attachment) => (
              <AttachmentPreview key={attachment.id} attachment={attachment} />
            ))}
          </AttachmentGroup>
        ) : null}
        {text ? (
          <Bubble align="end" className="max-w-[min(80%,56ch)]" variant="default">
            <BubbleContent className="rounded-2xl rounded-br-lg px-3.5 py-2 text-[13px] leading-[1.65] whitespace-pre-wrap shadow-[var(--shadow-card)]">
              {text.split(/((?:^|(?<=\s))[@$][^\s]+)/g).map((part, index) =>
                /^[@$]/.test(part) ? (
                  <mark key={index} className="rounded bg-primary/15 px-0.5 text-inherit">
                    {part}
                  </mark>
                ) : (
                  part
                ),
              )}
            </BubbleContent>
          </Bubble>
        ) : null}
        {delivery === "sending" ? (
          <span className="flex items-center gap-1.5 self-end text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Sending
          </span>
        ) : delivery === "uncertain" ? (
          <span className="self-end text-xs text-destructive">Not confirmed</span>
        ) : null}
      </MessageContent>
    </Message>
  );
}
