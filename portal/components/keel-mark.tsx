// The KEEL mark: a sailboat in side profile, sails above and the fin keel and rudder
// beneath. The box
// it sits in is tinted below the waterline (see .brand-mark), so the keel reads as the
// part under water that holds the boat level.
export function KeelMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 32 32">
      <path className="keel-sail" d="M15.2 1.8v8.4h8.6Z" />
      <path className="keel-sail keel-jib" d="M13.9 3.6v6.6H8.2Z" />
      <path className="keel-hull" d="M2.5 11.6h27l-2.4 3.4c-.8 1.2-2.2 1.9-3.7 1.9H8.7c-3.1 0-5.2-1.6-6.2-5.3Z" />
      <path className="keel-fin" d="M12.6 16.6h5.2l-1.6 8.3h-2.4Z" />
      <path className="keel-fin" d="M11.7 24.5h6.4a1.4 1.4 0 0 1 0 2.8h-6.4a1.4 1.4 0 0 1 0-2.8Z" />
      <path className="keel-fin" d="M5.6 16.4h2l-.5 4.6H6.1Z" />
    </svg>
  );
}
