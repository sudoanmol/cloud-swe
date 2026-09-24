"use client";

import type { DeviceLoginStatus } from "@cloud-swe/api/contracts";
import { ThreadApiError } from "@cloud-swe/api/client";
import { CircleAlertIcon, ExternalLinkIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

type DeviceLoginDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: DeviceLoginStatus | undefined;
  statusError: unknown;
  starting: boolean;
  onStartAgain: () => void;
};

/** ChatGPT device login. Closing the dialog stops browser polling, not the login. */
export function DeviceLoginDialog({
  open,
  onOpenChange,
  status,
  statusError,
  starting,
  onStartAgain,
}: DeviceLoginDialogProps) {
  const expired = statusError instanceof ThreadApiError && statusError.status === 404;

  const failed =
    (!expired && statusError !== undefined && statusError !== null) ||
    status?.status === "failed" ||
    status?.status === "expired";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect ChatGPT</DialogTitle>
          <DialogDescription>
            Open the verification page, enter the code below and approve the device.
          </DialogDescription>
        </DialogHeader>

        {starting || !status || status.status === "starting" ? (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner />
            Starting login
          </p>
        ) : null}

        {status?.status === "pending" ? (
          <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">
              Enter this code at the verification page:
            </p>
            <code className="rounded-lg bg-muted px-3 py-2 font-mono text-lg tracking-[0.2em]">
              {status.userCode}
            </code>
            <Button asChild variant="outline">
              <a href={status.verificationUri} rel="noreferrer" target="_blank">
                Open verification page
                <ExternalLinkIcon data-icon="inline-end" />
              </a>
            </Button>
            <p aria-live="polite" className="flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner />
              Waiting for approval
            </p>
          </div>
        ) : null}

        {status?.status === "authorized" ? (
          <Alert>
            <AlertTitle>ChatGPT connected</AlertTitle>
            <AlertDescription>Your credential was saved on the server.</AlertDescription>
          </Alert>
        ) : null}

        {expired || failed ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Login did not finish</AlertTitle>
            <AlertDescription>
              {expired
                ? "This login is no longer available, usually because the server restarted."
                : "The provider refused the device login."}
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          {expired || failed ? (
            <Button
              onClick={() => {
                onStartAgain();
              }}
              type="button"
            >
              Start again
            </Button>
          ) : null}
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
