import { pathToFileURL } from "node:url";
import type { PagePublisher } from "./types";
export const localPublisher: PagePublisher = {
  kind: "local", label: "local", format: "html",
  owns: (url) => url.startsWith("file://"),
  async publish({ file }) { return { url: pathToFileURL(file).href }; },
};
