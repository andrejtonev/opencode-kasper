import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import { z } from "zod"

/** The public V1 tool helper is an identity wrapper plus its Zod schema namespace. */
export const tool = Object.assign(
  <Args extends z.ZodRawShape>(input: {
    description: string
    args: Args
    execute(
      args: z.infer<z.ZodObject<Args>>,
      context: ToolContext,
    ): Promise<ToolResult>
  }) => input,
  { schema: z },
)
