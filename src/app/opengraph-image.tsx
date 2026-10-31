import { ImageResponse } from "next/og";
import { OWL_PATH, OWL_TRANSFORM, OWL_VIEWBOX } from "@/components/app/brand";

// Generated preview image for Open Graph + Twitter cards. Pure code (no
// external assets or fonts) so it renders on free hosting with no network.
// ImageResponse cannot read the app's CSS variables, so the palette is inline:
// ink background, moonlight text, rune-violet accent, sage green for the owl mark.
export const size = {
  width: 1200,
  height: 630
};

export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          backgroundColor: "#0A1311",
          color: "#E8EEE8"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 40, color: "#7FCB8C" }}>
          <svg width="35" height="56" viewBox={OWL_VIEWBOX}>
            <path d={OWL_PATH} transform={OWL_TRANSFORM} fill="#7FCB8C" />
          </svg>
          <span>PCBuildSage</span>
        </div>
        <div style={{ fontSize: 68, fontWeight: 700, marginTop: 28, lineHeight: 1.12 }}>
          AI PC build planner
        </div>
        <div style={{ fontSize: 32, marginTop: 28, color: "#B79CFF" }}>
          Tell the Sage your budget. Get a build with exact totals and buy links.
        </div>
        <div style={{ fontSize: 26, marginTop: 20, color: "#A2B2A8" }}>
          Parts in stock at retailers today, compatibility checked by code.
        </div>
      </div>
    ),
    { ...size }
  );
}
