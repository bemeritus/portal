import * as React from "react";

import { cn } from "@/lib/utils";

/** A little keycap. */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-block rounded-md border border-b-2 bg-secondary px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
