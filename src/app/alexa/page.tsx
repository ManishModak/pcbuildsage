import type { Metadata } from "next";
import { AlexaView } from "@/features/alexa/alexa-view";

export const metadata: Metadata = {
  title: "Sage Voice — talk to PCBuildSage",
  description:
    "Push-to-talk voice chat for PC builds: speak your budget and needs, hear a short spoken answer, and see the proposed build card."
};

export default function AlexaPage() {
  return <AlexaView />;
}
