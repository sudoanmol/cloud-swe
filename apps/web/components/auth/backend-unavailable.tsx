"use client";

import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export function BackendUnavailable() {
  const router = useRouter();

  return (
    <div className="flex h-dvh w-full items-center justify-center bg-background p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RefreshCwIcon />
          </EmptyMedia>
          <EmptyTitle>cloud-swe is unreachable</EmptyTitle>
          <EmptyDescription>Your session could not be checked. Try again shortly.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => router.refresh()} type="button">
            <RefreshCwIcon data-icon="inline-start" />
            Retry
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
