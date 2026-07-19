import { z } from "zod";
export const FrontierResultSchema = z.object({ role: z.literal("frontier"), readiness: z.enum(["ready", "not_ready"]), risks: z.array(z.string()), questions: z.array(z.string()) });
