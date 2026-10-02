// A tiny module-level notification store. Any client component calls toast() from an
// event handler; the single <Toaster /> in the layout renders and dismisses them.
// No timers live here, so calling toast() in a test or on the server is inert.
export type ToastTone = "success" | "info" | "warning";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
  href?: string;
  hrefLabel?: string;
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
