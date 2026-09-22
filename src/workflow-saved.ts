import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { parseWorkflow } from "./workflow-runtime";

const Name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)
  .refine((name) => name !== "run" && name !== "refresh", "This name is reserved for a workflow command");
export const SavedWorkflow = z.object({
  name: Name,
  description: z.string(),
  path: z.string(),
  scope: z.enum(["project", "user"]),
});

async function present(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
}

export function savedWorkflows(directory: string, canonical: string) {
  const user = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "workflows");
  const project = join(directory, ".opencode", "workflows");
  const roots = [
    { directory: project, scope: "project" as const },
    ...(resolve(canonical) === resolve(directory) ? [] : [{ directory: join(canonical, ".opencode", "workflows"), scope: "project" as const }]),
    { directory: user, scope: "user" as const },
  ];
  return {
    async list() {
      const found = new Map<string, z.infer<typeof SavedWorkflow>>();
      for (const root of roots) {
        if (!await present(root.directory)) continue;
        for (const file of await readdir(root.directory)) {
          if (!file.endsWith(".js")) continue;
          const name = file.slice(0, -3);
          if (!Name.safeParse(name).success || found.has(name)) continue;
          const path = join(root.directory, file);
          const info = await present(path);
          if (!info?.isFile() || info.isSymbolicLink()) continue;
          const script = await readFile(path, "utf8");
          let description: string;
          try {
            description = parseWorkflow(script).meta.description;
          } catch (error) {
            description = `Invalid workflow: ${String(error)}`;
          }
          found.set(name, { name, description, path, scope: root.scope });
        }
      }
      return [...found.values()];
    },
    async load(name: string) {
      Name.parse(name);
      const item = (await this.list()).find((item) => item.name === name);
      if (!item) throw new Error(`Saved workflow "${name}" not found`);
      const file = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        return await file.readFile("utf8");
      } finally {
        await file.close();
      }
    },
    async save(name: string, script: string, scope: "project" | "user") {
      Name.parse(name);
      parseWorkflow(script);
      const root = scope === "project" ? project : user;
      if (scope === "project") {
        for (const path of [dirname(root), root]) {
          if ((await present(path))?.isSymbolicLink()) throw new Error(`Cannot save workflows through symlink: ${path}`);
        }
      }
      await mkdir(root, { recursive: true, mode: 0o700 });
      const path = join(root, `${name}.js`);
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(script, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      return { path };
    },
  };
}
