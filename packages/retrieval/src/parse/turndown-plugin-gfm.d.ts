// turndown-plugin-gfm ships no types; this is the one export we use.
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const tables: TurndownService.Plugin;
}
