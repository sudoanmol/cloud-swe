"use client";

import { useQuery } from "@tanstack/react-query";
import { DownloadIcon, FileIcon, ImageIcon } from "lucide-react";
import { useEffect, useState } from "react";
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
import { authClient } from "@/lib/auth-client";
import { attachmentPreviewQueryOptions } from "@/lib/queries";

/** Private bytes are fetched with cookies, never through Next image optimization. */
export function AttachmentPreview({
  attachment,
  actions,
}: {
  attachment: PublicAttachmentMetadata;
  actions?: React.ReactNode;
}) {
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const image = attachment.classification === "image";

  const preview = useQuery({
    ...attachmentPreviewQueryOptions(userId ?? "anonymous", attachment.id),
    enabled: Boolean(userId) && image,
  });

  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const blob = preview.data;

    if (!blob || !/^image\/(png|jpeg|gif|webp)$/.test(blob.type)) {
      setUrl(null);

      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);

    return () => URL.revokeObjectURL(objectUrl);
  }, [preview.data]);

  return (
    <Attachment>
      <AttachmentMedia variant={image ? "image" : "icon"}>
        {url ? <img alt={attachment.filename} src={url} /> : image ? <ImageIcon /> : <FileIcon />}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.filename}</AttachmentTitle>
        <AttachmentDescription>
          {preview.isError ? "Preview unavailable. Download to retry." : image ? "Image" : "File"}
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
