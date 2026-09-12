"use client";

import { useEffect, useState } from "react";
import { fetchStatus, isHostedMode } from "@/lib/api-client";

export function useDeploymentMode(): { isHosted: boolean; mode: "local" | "hosted-demo" } {
  const [isHosted, setIsHosted] = useState<boolean>(() => isHostedMode());

  useEffect(() => {
    fetchStatus()
      .then((status) => {
        const mode = status?.deploymentMode ?? status?.mode;
        setIsHosted(mode === "hosted-demo" || isHostedMode());
      })
      .catch(() => {
        setIsHosted(isHostedMode());
      });
  }, []);

  return { isHosted, mode: isHosted ? "hosted-demo" : "local" };
}
