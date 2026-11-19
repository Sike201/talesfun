"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

const APP_BG = "#0a0a0a";

function isTalesPath(pathname: string) {
  return (
    pathname === "/" ||
    pathname === "/launches" ||
    pathname === "/create" ||
    pathname === "/docs" ||
    pathname.startsWith("/token/")
  );
}

export default function HomeBodyClass() {
  const pathname = usePathname();
  const isTales = isTalesPath(pathname);

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    body.style.backgroundColor = APP_BG;
    html.style.backgroundColor = APP_BG;
    if (isTales) {
      html.classList.add("home-landing");
      body.classList.add("home-landing");
    } else {
      html.classList.remove("home-landing");
      body.classList.remove("home-landing");
    }
  }, [isTales]);

  return null;
}
