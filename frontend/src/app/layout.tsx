import type { Metadata } from "next";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import WalletContextProvider from "@/context/WalletContextProvider";
import Navbar from "@/components/layout/Navbar";
import HomeBodyClass from "@/components/landing/HomeBodyClass";
import { Toaster } from "react-hot-toast";
import { cn } from "@/lib/utils";
import { geist, fraunces } from "@/lib/fonts";

export const metadata: Metadata = {
  title: "Tales — Launch markets powered by Omnipair",
  description:
    "Bonding curve launches that graduate into Omnipair — long or short any graduated token.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={cn(geist.variable, fraunces.variable)}>
      <body className={cn(geist.className, "antialiased")}>
        <WalletContextProvider>
          <HomeBodyClass />
          <Navbar />
          <main className="pb-20 md:pb-0 min-h-screen">{children}</main>
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                background: "#111827",
                color: "#F9FAFB",
                borderRadius: "8px",
                fontSize: "13px",
                fontWeight: 500,
              },
              success: {
                iconTheme: { primary: "#22C55E", secondary: "#FFFFFF" },
              },
            }}
          />
        </WalletContextProvider>
      </body>
    </html>
  );
}
