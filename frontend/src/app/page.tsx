import { Suspense } from "react";
import TokensDirectory from "@/components/markets/TokensDirectory";

function DirectoryFallback() {
  return (
    <div
      data-tales-page
      className="flex min-h-[50vh] items-center justify-center text-sm text-white/40"
    >
      Loading markets…
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<DirectoryFallback />}>
      <TokensDirectory />
    </Suspense>
  );
}