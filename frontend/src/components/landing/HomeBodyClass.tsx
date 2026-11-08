"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

const HOME_BG = "#000000";
const DEFAULT_BG = "#F3F4F6";

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
    if (isTales) {
      html.classList.add("home-landing");
      body.classList.add("home-landing");
      body.style.backgroundColor = HOME_BG;
      html.style.backgroundColor = HOME_BG;
    } else {
      html.classList.remove("home-landing");
      body.classList.remove("home-landing");
      body.style.backgroundColor = DEFAULT_BG;
      html.style.backgroundColor = DEFAULT_BG;
    }
  }, [isTales]);

  return null;
}
