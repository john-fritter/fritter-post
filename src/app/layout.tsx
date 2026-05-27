import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "The Fritter Post",
  description: "A personal daily newspaper.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
