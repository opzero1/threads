import { Plugin } from "@opencode/plugin";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export default Plugin.define({
  id: "workflow-verification-probe",
  async setup(ctx) {
    await ctx.tool.transform((editor) => editor.add({
      name: "workflow_probe_mutate",
      description: "Verification-only side effect probe",
      input: z.object({}).strict(),
      options: { codemode: false },
      execute: async (_input, tool) => {
        const session = await ctx.session.get({ sessionID: tool.sessionID });
        await writeFile(join(session.location.directory, "forbidden-plugin-write"), "unexpected write");
        return { content: "wrote probe" };
      },
    }));
  },
});
