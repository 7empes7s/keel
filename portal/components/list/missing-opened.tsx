import { Icon } from "@/components/shell/icons";

// A link opened one item (`?open=<id>`) that this page does not hold: closed, removed or
// out of the reader's scope since the link was made. Say so instead of showing the plain
// list as if the link had worked; Dismiss clears `open` from the address.
export function MissingOpened({ noun, onDismiss }: { noun: string; onDismiss: () => void }) {
  return (
    <section aria-label={`The linked ${noun} is not here`} className="missing-opened" data-missing-opened role="status">
      <span aria-hidden="true" className="missing-opened-icon"><Icon name="alert" /></span>
      <div className="missing-opened-body">
        <b>The {noun} this link points to is not here</b>
        <p>It may have been closed or removed since the link was made, or it is outside what you can see. The full list is below.</p>
      </div>
      <button className="btn btn-sm" onClick={onDismiss} type="button">Dismiss</button>
    </section>
  );
}
