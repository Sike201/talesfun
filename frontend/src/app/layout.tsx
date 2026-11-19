import type { Metadata } from "next";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import WalletContextProvider from "@/context/WalletContextProvider";
import Navbar from "@/components/layout/Navbar";
import SiteFooter from "@/components/layout/SiteFooter";
import HomeBodyClass from "@/components/landing/HomeBodyClass";
import { Toaster } from "react-hot-toast";
import { cn } from "@/lib/utils";
import { geist, fraunces } from "@/lib/fonts";

export const metadata: Metadata = {
  title: "Tales — Launch markets powered by Omnipair",
  description:
    "Bonding curve launches that graduate into Omnipair. Long or short any graduated token.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={cn(geist.variable, fraunces.variable, "dark")}>
      <body className={cn(geist.className, "antialiased")}>
        <WalletContextProvider>
          <HomeBodyClass />
          <Navbar />
          <main className="flex min-h-screen flex-col pb-20 md:pb-0">
            <div className="flex-1">{children}</div>
            <div className="mt-auto">
              <SiteFooter />
            </div>
          </main>
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                background: "oklch(0.21 0.004 62)",
                color: "oklch(0.985 0.002 75)",
                border: "1px solid oklch(1 0 0 / 10%)",
                borderRadius: "12px",
                fontSize: "13px",
                fontWeight: 500,
              },
              success: {
                iconTheme: { primary: "#4ade80", secondary: "#ffffff" },
              },
            }}
          />
        </WalletContextProvider>
      </body>
    </html>
  );
}
