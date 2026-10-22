import { refusalWords } from "@/lib/error-words";

// A tiny module-level notification store. Any client component calls toast() from an
// event handler; the single <Toaster /> in the layout renders and dismisses them.
// No timers live here, so calling toast() in a test or on the server is inert.
export type ToastTone = "success" | "info" | "warning";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
  // The next step, shown as "What to do:". Set it whenever the toast reports a failure.
  todo?: string;
  // The server's raw answer: shown only behind "Show details", never in plain view.
  // Without a detail, the plain cause comes from lib/error-words.ts.
  error?: unknown;
  href?: string;
  hrefLabel?: string;
  // A button on the toast, such as Undo. Running it closes the toast.
  action?: { label: string; run: () => void };
}

/** A refused request's toast fields: plain words for the status, with the server's raw
 *  answer kept for "Show details". Spread it into toast(). */
export function refused(status: number, error: unknown): Pick<Toast, "detail" | "todo" | "error"> {
  const words = refusalWords(status);
  return { detail: words.cause, todo: words.todo, error };
}

type Listener = () => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const MAX_VISIBLE = 4;

function emit() {
  for (const listener of listeners) listener();
}

export function toast(input: Omit<Toast, "id" | "tone"> & { tone?: ToastTone }): number {
  const id = nextId++;
  toasts = [...toasts, { ...input, tone: input.tone ?? "success", id }].slice(-MAX_VISIBLE);
  emit();
  return id;
}

export function dismissToast(id: number): void {
  const next = toasts.filter((item) => item.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): Toast[] {
  return toasts;
}

const EMPTY: Toast[] = [];
export function getServerToasts(): Toast[] {
  return EMPTY;
}
