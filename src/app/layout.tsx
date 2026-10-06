import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SessionProvider } from "@/contexts/SessionContext";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Help Desk — IT Ticketing",
  description: "IT ticketing system with SLA tracking and email intake",
  icons: { icon: "/ticketing.png" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-mono antialiased min-h-screen bg-background text-foreground`}
      >
        {/* Mounted at the root so the login page can read the session too. */}
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}