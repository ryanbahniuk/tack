import { resolve } from "node:path";
import type { BootRecipe, Project, TackConfig } from "../config/schema";

export class BootRecipeError extends Error {}
export interface BootPlan {
  project: string; lock: string; cwd: string; env: Record<string, string>;
  up: string[]; run?: string; down: string[]; status?: string; url?: string;
}
export function resolveRecipe(config: TackConfig, project: Project): BootRecipe {
  if (!project.boot) throw new BootRecipeError(`Project ${project.name} has no boot configuration; add boot to the project and optionally define bootRecipes.`);
  const { recipe, ...inline } = project.boot;
  const base = recipe ? config.bootRecipes[recipe] : undefined;
  if (recipe && !base) throw new BootRecipeError(`Unknown boot recipe ${recipe} for ${project.name}.`);
  const result = { ...base, ...inline, vars: { ...base?.vars, ...inline.vars }, env: { ...base?.env, ...inline.env } };
  if (!result.up?.length && !result.run) throw new BootRecipeError(`Project ${project.name} boot recipe needs up or run.`);
  return result;
}
const shellArg = (value: string) => /^[a-zA-Z0-9_./:@+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
export function buildPlan(recipe: BootRecipe, ctx: { project: string; path: string; session: string; agent: string; branch: string }): BootPlan {
  const cwd = resolve(ctx.path);
  const builtins: Record<string, string> = { ...ctx, path: cwd };
  const expand = (value: string, values: Record<string, string>, quote = false) => value.replace(/\{([^{}]+)\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) throw new BootRecipeError(`Unknown placeholder {${key}} for project ${ctx.project}.`);
    return quote ? shellArg(values[key]!) : values[key]!;
  });
  const vars = Object.fromEntries(Object.entries(recipe.vars ?? {}).map(([k, v]) => [k, expand(v, builtins)]));
  const values = { ...vars, ...builtins };
  const plain = (v: string) => expand(v, values);
  const cmd = (v: string) => expand(v, values, true);
  return { project: ctx.project, lock: plain(recipe.lock ?? "{project}"), cwd,
    env: { ...Object.fromEntries(Object.entries(recipe.env ?? {}).map(([k,v]) => [k, plain(v)])), TACK_SESSION: ctx.session, TACK_PROJECT: ctx.project, TACK_WORKTREE: cwd },
    up: (recipe.up ?? []).map(cmd), run: recipe.run === undefined ? undefined : cmd(recipe.run),
    down: (recipe.down ?? []).map(cmd), status: recipe.status === undefined ? undefined : cmd(recipe.status), url: recipe.url === undefined ? undefined : plain(recipe.url) };
}
