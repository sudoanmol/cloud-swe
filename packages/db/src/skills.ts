import { z } from "zod";

export const skillMetadataSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  path: z.string().min(1).max(4096),
});

export const skillsCatalogSchema = z.object({
  skills: z.array(skillMetadataSchema).max(200),
});

export type SkillMetadata = z.infer<typeof skillMetadataSchema>;

/** Global skill shipped by infra/modal/install-toolchain.sh; keep in sync with the image. */
export const imageSkills: SkillMetadata[] = [
  {
    name: "agent-browser",
    description:
      "Browser automation CLI for navigating pages, filling forms, and taking screenshots.",
    path: "/root/.agents/skills/agent-browser/SKILL.md",
  },
];
