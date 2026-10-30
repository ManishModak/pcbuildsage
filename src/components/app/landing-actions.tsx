"use client";

import { createContext, useContext } from "react";
import { Button } from "@/components/ui/primitives";

// HomeClient provides this so the server-rendered landing's button can open
// setup. Before hydration (and for crawlers) the button does nothing.
export const LandingActionsContext = createContext<{ startSetup: () => void }>({ startSetup: () => {} });

export function StartSetupButton({ children }: { children: string }) {
  const { startSetup } = useContext(LandingActionsContext);
  return (
    <Button onClick={startSetup} className="min-h-12 px-6 text-base">
      {children}
    </Button>
  );
}
