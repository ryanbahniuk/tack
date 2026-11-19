import { pathToFileURL } from "node:url";
import type { PagePublisher } from "./types";
export const localPublisher: PagePublisher = {
  kind: "local", label: "local", async publish({ file }) { return { url: pathToFileURL(file).href }; },
};
