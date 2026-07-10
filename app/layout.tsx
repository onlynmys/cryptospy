import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CryptoSpy — Smart Wallet Tracker",
  description: "Track smart money wallets on DEX in real-time",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full flex flex-col bg-[#070b14] text-slate-200 antialiased">
        {children}
      </body>
    </html>
  );
}
