import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Fritter Post",
  description: "A personal daily newspaper.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href={
            "https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700" +
            "&family=Newsreader:ital,opsz,wght@0,6..72,300..800;1,6..72,300..600&display=swap"
          }
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
