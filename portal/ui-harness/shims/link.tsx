import type { AnchorHTMLAttributes } from "react";
// The harness renders plain anchors; next/link's prefetch setting has no meaning here.
export default function Link({ href, prefetch: _prefetch, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean | null }) {
  return <a {...rest} href={`#${href}`} />;
}
