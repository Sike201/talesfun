"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

function isTalesPath(pathname: string) {
  return (
    pathname === "/" ||
    pathname === "/launches" ||
    pathname === "/create" ||
    pathname === "/docs" ||
    pathname.startsWith("/token/")
  );
}

const LINKS = [
  { href: "/docs", label: "Docs", external: false },
  { href: "/create", label: "Launch", external: false },
  {
    href: "https://docs.omnipair.fi",
    label: "Omnipair",
    external: true,
  },
  {
    href: "https://x.com/Talesdotfun",
    label: "X",
    external: true,
  },
];

export default function SiteFooter() {
  const pathname = usePathname();
  if (!isTalesPath(pathname)) return null;

  return (
    <footer className="relative z-[1] w-full">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-start sm:justify-between sm:px-6 md:px-8">
        <div className="max-w-sm">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/tales-mark.png" alt="" className="h-5 w-5 rounded-[4px]" />
            <p className="text-[15px] font-semibold tracking-tight text-white">Tales</p>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-white/45">
            Bonding curves that graduate into Omnipair. Long, short, or spot any
            graduated market.
          </p>
          <p className="mt-5 text-[11px] text-white/28">
            © {new Date().getFullYear()} Tales · powered by Omnipair
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] font-medium">
          {LINKS.map(link =>
            link.external ? (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/50 transition-colors hover:text-white"
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.label}
                href={link.href}
                className="text-white/50 transition-colors hover:text-white"
              >
                {link.label}
              </Link>
            )
          )}
        </nav>
      </div>
    </footer>
  );
}
