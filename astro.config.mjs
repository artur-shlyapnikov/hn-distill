import { defineConfig } from "astro/config";

const site = process.env.SITE || undefined;
const base = process.env.BASE || "/";

export default defineConfig({
  output: "static",
  site,
  base,
});
