import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** apps/web/src/app */
export const APP_DIR = path.resolve(__dirname, "../../src/app");

/**
 * Static routes ("/problems", "/admin/students") that have a page file.
 * Route groups like "(student)" do not appear in URLs; private folders and
 * parallel slots are skipped. Dynamic segments stay as written ("/admin/students/[id]").
 */
export function implementedRoutes(appDir: string = APP_DIR): Set<string> {
  const routes = new Set<string>();
  const walk = (dir: string, segments: string[]) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name.startsWith("_") || name.startsWith("@")) continue;
        const isGroup = name.startsWith("(") && name.endsWith(")");
        walk(full, isGroup ? segments : [...segments, name]);
      } else if (/^page\.(tsx|ts|jsx|js|mdx)$/.test(name)) {
        routes.add(segments.length === 0 ? "/" : `/${segments.join("/")}`);
      }
    }
  };
  walk(appDir, []);
  return routes;
}
