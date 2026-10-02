// A template (unlike a layout) remounts on every navigation, so its entrance animation
// replays per route. Children are staggered by CSS; reduced motion disables it all.
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-transition">{children}</div>;
}
