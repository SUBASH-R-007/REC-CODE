import { contextBridge, ipcRenderer } from "electron";

/**
 * The bridge between the exam page and the application, and it is
 * deliberately almost empty.
 *
 * A preload runs with Node available in the renderer's isolated world, so
 * everything exposed here is reachable by the page — and the page is the
 * one thing in this product a candidate can put their own JavaScript into
 * (the console is gone, but a paste into an editor component runs in the
 * same world). So the rule is: expose facts, never capabilities. Nothing
 * here can read a file, start a process, change a window, or reach the
 * sitting key, which lives in the main process and never crosses this
 * boundary.
 *
 * `quitAfterSubmit` is the one thing that acts, and all it can do is end
 * the application — which a candidate could do by closing the window
 * anyway.
 */
contextBridge.exposeInMainWorld("recxExamBrowser", {
  /** So the page can say "you are in the exam browser" and show its version. */
  version: () => ipcRenderer.invoke("recx:version") as Promise<string>,
  /**
   * How many displays this machine has. The page shows it on the
   * readiness check so a candidate can unplug a second monitor BEFORE the
   * clock starts rather than be flagged for it afterwards — which is the
   * difference between a control and a trap.
   */
  displays: () => ipcRenderer.invoke("recx:displays") as Promise<number>,
  /** End the sitting: forget the key and quit. */
  finish: () => ipcRenderer.send("recx:finish"),
});
