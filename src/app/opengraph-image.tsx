import { ImageResponse } from "next/og";

// Generated preview image for Open Graph + Twitter cards. Pure code (no
// external assets or fonts) so it renders on free hosting with no network.
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
          backgroundColor: "#0e1210",
          color: "#f2f5f0"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", fontSize: 44, color: "#7dc383" }}>
          PCBuildSage
        </div>
        <div style={{ fontSize: 64, fontWeight: 700, marginTop: 16, lineHeight: 1.15 }}>
          AI PC build planner for India
        </div>
        <div style={{ fontSize: 32, marginTop: 24, color: "#b9c4b6" }}>
          In-stock parts, exact totals, buy links, compatibility checked by code.
        </div>
      </div>
    ),
    { ...size }
  );
}
