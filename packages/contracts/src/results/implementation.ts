import { z } from "zod";
export const ImplementationResultSchema = z.object({ role: z.literal("implementation"), status: z.enum(["completed", "blocked"]), summary: z.string().min(1), deviationRequest: z.string().optional() });
