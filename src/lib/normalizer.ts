const BRAND_CANONICAL: Record<string, string> = {
  "g.skill": "g skill",
  "g-skill": "g skill",
  gskill: "g skill",
  "western digital": "wd",
  wd_black: "wd black",
  "cooler master": "cooler master",
  "be quiet!": "be quiet"
};

const MARKETING_SUFFIXES = [
  /\b(gaming|wifi|wi-fi|rgb|oc|edition|graphics card|processor|desktop processor|cooler|airflow)\b/g,
  /\b\d+x\d+gb\b/g
];

export function normalizeTitle(input: string): string {
  let value = input.toLowerCase().normalize("NFKD");
  value = value.replace(/[™®©]/g, "");
  for (const [from, to] of Object.entries(BRAND_CANONICAL)) {
    value = value.replaceAll(from, to);
  }
  for (const pattern of MARKETING_SUFFIXES) {
    value = value.replace(pattern, " ");
  }
  return value.replace(/[^a-z0-9.+-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function slugifyComponent(input: string): string {
  return normalizeTitle(input).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
