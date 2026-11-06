import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "BBC · Quality & Operations",
  description: "Internal quality and laboratory operations workspace",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
