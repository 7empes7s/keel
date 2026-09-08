import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "KEEL Operator Portal",
  description: "Microsoft 365 disaster-recovery operator console",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

