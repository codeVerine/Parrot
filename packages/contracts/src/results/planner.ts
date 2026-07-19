import { z } from "zod";
export const PlannerResultSchema = z.object({ role: z.literal("planner"), proposalPath: z.string().min(1), summary: z.string().min(1), objectionsAddressed: z.array(z.string()) });
export type PlannerResult = z.infer<typeof PlannerResultSchema>;
