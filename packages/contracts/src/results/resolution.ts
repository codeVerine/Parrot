import { z } from "zod";
export const ResolutionResultSchema = z.object({ role: z.literal("resolution"), verified: z.array(z.string()), unresolved: z.array(z.string()) });
