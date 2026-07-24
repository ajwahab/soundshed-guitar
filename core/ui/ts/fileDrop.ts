import { showNotification } from "./notifications.js";

export type GlobalFileDropHandler = {
  id: string;
  priority?: number;
  handle: (files: File[], event: DragEvent) => Promise<boolean> | boolean;
};

const globalFileDropHandlers = new Map<string, GlobalFileDropHandler>();
let globalDropInitialized = false;
let appRootElement: HTMLElement | null = null;

function hasFilePayload(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer?.types ?? []);
  return types.includes("Files");
}

function setDropActive(active: boolean): void {
  appRootElement?.classList.toggle("riff-drop-active", active);
}

function getOrderedHandlers(): GlobalFileDropHandler[] {
  return Array.from(globalFileDropHandlers.values()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

export function registerGlobalFileDropHandler(handler: GlobalFileDropHandler): void {
  globalFileDropHandlers.set(handler.id, handler);
}

export function initializeGlobalFileDrop(): void {
  if (globalDropInitialized) {
    return;
  }
  globalDropInitialized = true;
  appRootElement = document.getElementById("app");

  document.addEventListener("dragenter", (event) => {
    if (!hasFilePayload(event) || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    setDropActive(true);
  });

  document.addEventListener("dragover", (event) => {
    if (!hasFilePayload(event) || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    setDropActive(true);
  });

  document.addEventListener("dragleave", (event) => {
    const related = event.relatedTarget as Node | null;
    if (!related || !appRootElement?.contains(related)) {
      setDropActive(false);
    }
  });

  document.addEventListener("dragend", () => {
    setDropActive(false);
  });

  document.addEventListener("drop", async (event) => {
    if (!hasFilePayload(event)) {
      return;
    }
    if (event.defaultPrevented) {
      setDropActive(false);
      return;
    }

    event.preventDefault();
    setDropActive(false);

    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) {
      return;
    }

    for (const handler of getOrderedHandlers()) {
      try {
        const handled = await handler.handle(files, event);
        if (handled) {
          return;
        }
      } catch (error) {
        showNotification("Drop handling failed", error instanceof Error ? error.message : String(error));
        return;
      }
    }
  });
}
