import { z } from "zod";
export const MergeResultSchema = z.object({ role: z.literal("merge"), clusters: z.array(z.object({ clusterId: z.string().min(1), objectionIds: z.array(z.string().min(1)), severity: z.enum(["blocking", "major", "minor"]) })) });
