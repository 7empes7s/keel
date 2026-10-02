import type { AnchorHTMLAttributes } from "react";
export default function Link({ href, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a {...rest} href={`#${href}`} />;
}
