import { ImageResponse } from "next/og";

// Generated preview image for Open Graph + Twitter cards. Pure code (no
// external assets or fonts) so it renders on free hosting with no network.
// ImageResponse cannot read the app's CSS variables, so the palette is inline:
// ink background, moonlight text, rune-violet accent, leaf green for the mark.
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
          <svg width="56" height="56" viewBox="0 0 64 64">
            <g fill="none" stroke="#7FCB8C" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round">
              <path d="M32 53c-11-2.4-19-11.5-19-24.5C13 17 21.5 10 32 10s19 7 19 18.5C51 41.5 43 50.6 32 53Z" />
              <path d="M32 51V17" />
              <path d="M32 29 24 24.5M32 39 23.5 34M32 34.5l8-5M32 41l8.5-5.5" />
            </g>
          </svg>
          <span>PCBuildSage</span>
        </div>
        <div style={{ fontSize: 68, fontWeight: 700, marginTop: 28, lineHeight: 1.12 }}>
          AI PC build planner for India
        </div>
        <div style={{ fontSize: 32, marginTop: 28, color: "#B79CFF" }}>
          Tell the Sage your budget. Get a build with exact totals and buy links.
        </div>
        <div style={{ fontSize: 26, marginTop: 20, color: "#A2B2A8" }}>
          Parts from Indian retailers, compatibility checked by code.
        </div>
      </div>
    ),
    { ...size }
  );
}
