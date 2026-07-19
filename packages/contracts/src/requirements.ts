import { z } from "zod";
export const RequirementSchema = z.object({ id: z.string().min(1), sourcePath: z.string().min(1), contentHash: z.string().min(1), priority: z.enum(["must", "should", "could"]), externalId: z.string().min(1).optional(), text: z.string().min(1) });
export type Requirement = z.infer<typeof RequirementSchema>;
