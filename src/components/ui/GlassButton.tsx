"use client";

import Link from "next/link";

interface Props {
  href: string;
  children: React.ReactNode;
}

export default function GlassButton({ href, children }: Props) {
  return (
    <div className="glass-btn-wrap">
      <Link href={href} className="glass-btn-el">
        <span>{children}</span>
      </Link>
      <div className="glass-btn-shadow" />
    </div>
  );
}
