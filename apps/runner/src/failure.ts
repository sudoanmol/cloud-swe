import { z } from "zod";

const failureSchema = z.object({
  type: z.string().optional().catch(undefined),
  code: z.string().optional().catch(undefined),
  cause: z.unknown().optional(),
});

type FailureIdentity = Pick<z.infer<typeof failureSchema>, "type" | "code">;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Temporal and SDK errors enter here before recovery routing.
export function failureIdentities(error: unknown): FailureIdentity[] {
  const identities: FailureIdentity[] = [];
  const seen = new Set<unknown>();
  let current = error;

  while (!seen.has(current)) {
    seen.add(current);
    const parsed = failureSchema.safeParse(current);

    if (!parsed.success) break;
    const { type, code, cause } = parsed.data;
    identities.push({ type, code });
    current = cause;
  }

  return identities;
}
