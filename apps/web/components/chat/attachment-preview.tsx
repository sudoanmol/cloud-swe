"use client";

import { DownloadIcon, FileIcon, ImageIcon } from "lucide-react";
import { useState } from "react";
import type { PublicAttachmentMetadata } from "@cloud-swe/api/contracts";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { api } from "@/lib/api";

/**
 * Private bytes are fetched with cookies, never through Next image optimization.
 * Images show the bounded model variant and load only near the viewport.
 */
export function AttachmentPreview({
  attachment,
  actions,
}: {
  attachment: PublicAttachmentMetadata;
  actions?: React.ReactNode;
}) {
  const image = attachment.classification === "image";
  const [failed, setFailed] = useState(false);

  return (
    <Attachment>
      <AttachmentMedia variant={image ? "image" : "icon"}>
        {image && !failed ? (
          <img
            alt={attachment.filename}
            decoding="async"
            loading="lazy"
            onError={() => setFailed(true)}
            src={api.url(`/api/attachments/${attachment.id}/preview`)}
          />
        ) : image ? (
          <ImageIcon />
        ) : (
          <FileIcon />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.filename}</AttachmentTitle>
        <AttachmentDescription>
          {failed ? "Preview unavailable. Download to retry." : image ? "Image" : "File"}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction asChild>
          <a
            aria-label={`Download ${attachment.filename}`}
            href={api.url(`/api/attachments/${attachment.id}`)}
            download={attachment.filename}
            rel="noopener noreferrer"
            target="_blank"
          >
            <DownloadIcon />
          </a>
        </AttachmentAction>
        {actions}
      </AttachmentActions>
    </Attachment>
  );
}
