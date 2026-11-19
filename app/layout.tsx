import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Droply — Simple file downloader",
  description: "Download files from a link in a few simple clicks.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
