import { expect, test } from "bun:test";

for (const alias of ["refresh", "reconnect"]) {
  test(`${alias} routes to restart and accepts --force`, async () => {
    const proc = Bun.spawn([process.execPath, "run", "./bin/tack.ts", "session", alias, "--all", "--force"], {
      env: { ...process.env, TACK_HOME: `/tmp/tack-alias-missing-${crypto.randomUUID()}` }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();
    await proc.exited;
    expect(output).toContain(`\`tack session ${alias}\` is now \`tack session restart\``);
    expect(error).toContain("No config found");
  });
}
