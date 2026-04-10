import type { Metadata } from "next";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import WalletContextProvider from "@/context/WalletContextProvider";
import Navbar from "@/components/layout/Navbar";
import { Toaster } from "react-hot-toast";

export const metadata: Metadata = {
  title: "higher.run — Launch an idea and make it liquid capital",
  description:
    "The DeFi-native token launchpad on Solana. Launch on a bonding curve, graduate to Omnipair GAMM, borrow, leverage, and earn perpetual royalties.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased" style={{ backgroundColor: "#F3F4F6" }}>
        <WalletContextProvider>
          <Navbar />
          <main className="pb-20 md:pb-0">{children}</main>
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
