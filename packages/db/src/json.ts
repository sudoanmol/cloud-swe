import { z } from "zod";

export const jsonValueSchema = z.json();

export type JsonValue = z.infer<typeof jsonValueSchema>;

/** JSON object fields may be omitted by JSON.stringify when their value is undefined. */
export type JsonObject = { [key: string]: JsonValue | undefined };
