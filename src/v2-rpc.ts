import { Rpc } from "@opencode/schema/rpc"
import { Schema } from "effect"
export const CommandResultSchema = Schema.toStandardSchemaV1(
  Schema.Struct({
    requestID: Schema.String,
    sessionID: Schema.String,
    location: Schema.String,
    action: Schema.String,
    status: Schema.Literals(["ok", "unsupported", "failed", "cancelled"]),
    text: Schema.String,
    timestamp: Schema.Number,
  }),
)
export const kasperRpc = Rpc.define({
  id: "kasper",
  methods: {
    execute: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          requestID: Schema.String,
          sessionID: Schema.String,
          location: Schema.String,
          command: Schema.String,
        }),
      ),
      output: CommandResultSchema,
    },
    results: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ sessionID: Schema.String, location: Schema.String }),
      ),
      output: Schema.toStandardSchemaV1(Schema.Array(CommandResultSchema)),
    },
  },
  events: { result: { schema: CommandResultSchema } },
})
