import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findAllBuildVersions, validationStrip } from "../build-derive";
import { BuildCard } from "../build-card";
import { MessageView, type ChatUIMessage } from "../message";
import type { ValidationResult } from "@/types/client";

describe("Build Versions and UI Accessibility (Issue 08)", () => {
  const sampleMessages: ChatUIMessage[] = [
    {
      id: "msg-user-1",
      role: "user",
      parts: [{ type: "text", text: "Propose a gaming PC build for ₹80,000" }]
    },
    {
      id: "msg-asst-1",
      role: "assistant",
      parts: [
        {
          type: "tool-present_build",
          toolCallId: "call-v1",
          state: "output-available",
          input: {
            builds: [
              {
                label: "Initial 1080p Build",
                parts: [
                  { category: "gpu", name: "RTX 4060 8GB", price: 28500, currency: "INR" },
                  { category: "cpu", name: "Ryzen 5 5600", price: 11200, currency: "INR" }
                ]
              }
            ]
          },
          output: { presented: true }
        },
        {
          type: "text",
          text: "Here is your initial build recommendation."
        }
      ]
    },
    {
      id: "msg-user-2",
      role: "user",
      parts: [{ type: "text", text: "Can we upgrade to AM5 and DDR5 for future upgradability?" }]
    },
    {
      id: "msg-asst-2",
      role: "assistant",
      parts: [
        {
          type: "tool-present_build",
          toolCallId: "call-v2",
          state: "output-available",
          input: {
            builds: [
              {
                label: "AM5 Option A: Balanced",
                parts: [
                  { category: "gpu", name: "RTX 4060 8GB", price: 28500, currency: "INR" },
                  { category: "cpu", name: "Ryzen 5 7600", price: 18500, currency: "INR" }
                ]
              },
              {
                label: "AM5 Option B: Stretch GPU",
                parts: [
                  { category: "gpu", name: "RTX 4060 Ti 8GB", price: 37000, currency: "INR" },
                  { category: "cpu", name: "Ryzen 5 7600", price: 18500, currency: "INR" }
                ]
              }
            ]
          },
          output: { presented: true }
        },
        {
          type: "text",
          text: "Here are two AM5 options with improved upgrade paths."
        }
      ]
    }
  ];

  it("findAllBuildVersions finds all build versions across assistant messages", () => {
    const versions = findAllBuildVersions(sampleMessages, "INR");
    expect(versions).toHaveLength(2);

    expect(versions[0].version).toBe(1);
    expect(versions[0].messageIndex).toBe(1);
    expect(versions[0].label).toBe("Version 1");
    expect(versions[0].builds).toHaveLength(1);
    expect(versions[0].builds[0].label).toBe("Initial 1080p Build");
    expect(versions[0].builds[0].components[1].name).toBe("Ryzen 5 5600");
    expect(versions[0].builds[0].components[1].price).toBe(11200);

    expect(versions[1].version).toBe(2);
    expect(versions[1].messageIndex).toBe(3);
    expect(versions[1].label).toBe("Version 2");
    expect(versions[1].builds).toHaveLength(2);
    expect(versions[1].builds[0].label).toBe("AM5 Option A: Balanced");
    expect(versions[1].builds[1].label).toBe("AM5 Option B: Stretch GPU");
    expect(versions[1].builds[0].components[1].name).toBe("Ryzen 5 7600");
    expect(versions[1].builds[0].components[1].price).toBe(18500);
  });

  it("findAllBuildVersions returns empty array when no builds are present", () => {
    const noBuildMessages: ChatUIMessage[] = [
      { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      { id: "2", role: "assistant", parts: [{ type: "text", text: "Hi! How can I help you today?" }] }
    ];
    const versions = findAllBuildVersions(noBuildMessages, "INR");
    expect(versions).toEqual([]);
  });

  it("renders Previous versions control when multiple versions exist", () => {
    const versions = findAllBuildVersions(sampleMessages, "INR");
    const markup = renderToStaticMarkup(<BuildCard versions={versions} inSidePanel />);

    expect(markup).toContain('aria-label="Previous versions"');
    expect(markup).toContain("Version 1");
    expect(markup).toContain("Version 2 (Latest)");
    // Defaults to latest version (v2), which has Option A and Option B tabs
    expect(markup).toContain("AM5 Option A: Balanced");
    expect(markup).toContain("AM5 Option B: Stretch GPU");
    expect(markup).toContain('role="tablist"');
  });

  it("renders selected previous version with original parts and prices", () => {
    const versions = findAllBuildVersions(sampleMessages, "INR");
    const markup = renderToStaticMarkup(
      <BuildCard versions={versions} selectedVersion={1} inSidePanel />
    );

    expect(markup).toContain('aria-label="Previous versions"');
    expect(markup).toContain("Initial 1080p Build");
    expect(markup).toContain("Ryzen 5 5600");
    expect(markup).toContain("₹11,200");
  });

  it("validationStrip displays honest summary badges when checks are unverified", () => {
    const validation: ValidationResult = {
      valid: true,
      resolved: {},
      issues: [
        {
          severity: "needs_verification",
          rule: "clearance",
          components: ["gpu", "case"],
          detail: "GPU clearance not confirmed in case specifications."
        }
      ],
      summary: {
        passed: 6,
        failed: 0,
        unverified: 1,
        text: "6 checks passed · 1 unverified"
      }
    };

    const badges = validationStrip(validation);
    const summaryBadge = badges.find((b) => b.kind === "unverified" && b.label.includes("checks passed"));
    expect(summaryBadge).toBeDefined();
    expect(summaryBadge?.label).toBe("6 checks passed · 1 unverified");
  });

  it("validationStrip computes passed and unverified counts when summary object is omitted", () => {
    const validation: ValidationResult = {
      valid: true,
      resolved: {},
      issues: [
        {
          severity: "needs_verification",
          rule: "clearance",
          components: ["gpu", "case"],
          detail: "GPU clearance unverified"
        }
      ],
      skipped_checks: []
    };

    const badges = validationStrip(validation);
    // 7 total rules - 1 unverified - 0 skipped = 6 passed
    const summaryBadge = badges.find((b) => b.label.includes("checks passed"));
    expect(summaryBadge).toBeDefined();
    expect(summaryBadge?.label).toBe("6 checks passed · 1 unverified");
    expect(summaryBadge?.kind).toBe("unverified");
  });

  it("validationStrip displays passed count when all checks pass", () => {
    const validation: ValidationResult = {
      valid: true,
      resolved: {},
      issues: [],
      skipped_checks: []
    };

    const badges = validationStrip(validation);
    expect(badges[0].kind).toBe("ok");
    expect(badges[0].label).toBe("7 checks passed");
  });

  it("creates 2 distinct versions in history from two present_build calls in a single assistant message", () => {
    const singleMessageMultiPresent: ChatUIMessage[] = [
      {
        id: "msg-user-1",
        role: "user",
        parts: [{ type: "text", text: "Propose a build" }]
      },
      {
        id: "msg-asst-1",
        role: "assistant",
        parts: [
          {
            type: "tool-present_build",
            toolCallId: "call-1",
            state: "output-available",
            input: {
              builds: [
                {
                  label: "Draft 1: Entry Level",
                  parts: [
                    { category: "gpu", name: "RTX 4060", price: 28000, currency: "INR" },
                    { category: "cpu", name: "Ryzen 5 5600", price: 11000, currency: "INR" }
                  ]
                }
              ]
            },
            output: { presented: true }
          },
          {
            type: "tool-present_build",
            toolCallId: "call-2",
            state: "output-available",
            input: {
              builds: [
                {
                  label: "Draft 2: Mid Range",
                  parts: [
                    { category: "gpu", name: "RTX 4070", price: 54000, currency: "INR" },
                    { category: "cpu", name: "Ryzen 5 7600", price: 18000, currency: "INR" }
                  ]
                }
              ]
            },
            output: { presented: true }
          }
        ]
      }
    ];

    const versions = findAllBuildVersions(singleMessageMultiPresent, "INR");
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(1);
    expect(versions[0].label).toBe("Version 1");
    expect(versions[0].builds[0].label).toBe("Draft 1: Entry Level");
    expect(versions[0].builds[0].components[0].name).toBe("RTX 4060");

    expect(versions[1].version).toBe(2);
    expect(versions[1].label).toBe("Version 2");
    expect(versions[1].builds[0].label).toBe("Draft 2: Mid Range");
    expect(versions[1].builds[0].components[0].name).toBe("RTX 4070");
  });

  it("attaches validation to the matching present_build version and discloses unverified when not matched", () => {
    const messagesWithValidation: ChatUIMessage[] = [
      {
        id: "msg-user-1",
        role: "user",
        parts: [{ type: "text", text: "Propose a build with validation" }]
      },
      {
        id: "msg-asst-1",
        role: "assistant",
        parts: [
          {
            type: "tool-validate_build",
            toolCallId: "val-1",
            state: "output-available",
            input: {
              label: "Validated AM5 Build",
              parts: {
                gpu: "RTX 4060 8GB",
                cpu: "Ryzen 5 7600"
              }
            },
            output: {
              valid: true,
              resolved: {},
              issues: [
                {
                  severity: "needs_verification",
                  rule: "clearance",
                  components: ["gpu"],
                  detail: "GPU clearance not confirmed in case"
                }
              ],
              checks: [],
              skipped_checks: []
            } as ValidationResult
          },
          {
            type: "tool-present_build",
            toolCallId: "call-1",
            state: "output-available",
            input: {
              builds: [
                {
                  label: "Validated AM5 Build",
                  parts: [
                    { category: "gpu", name: "RTX 4060 8GB", price: 28500, currency: "INR" },
                    { category: "cpu", name: "Ryzen 5 7600", price: 18500, currency: "INR" }
                  ]
                }
              ]
            },
            output: { presented: true }
          },
          {
            type: "tool-present_build",
            toolCallId: "call-2",
            state: "output-available",
            input: {
              builds: [
                {
                  label: "Unvalidated Intel Build",
                  parts: [
                    { category: "gpu", name: "RTX 4080 Super", price: 95000, currency: "INR" },
                    { category: "cpu", name: "Core i7-14700K", price: 36000, currency: "INR" }
                  ]
                }
              ]
            },
            output: { presented: true }
          }
        ]
      }
    ];

    const versions = findAllBuildVersions(messagesWithValidation, "INR");
    expect(versions).toHaveLength(2);

    // Version 1 has matching validation attached
    const v1Build = versions[0].builds[0];
    expect(v1Build.validation).not.toBeNull();
    expect(v1Build.validation?.valid).toBe(true);
    const gpuComponent = v1Build.components.find((c) => c.category === "gpu");
    expect(gpuComponent?.unverified).toBe(true);
    expect(gpuComponent?.unverifiedNote).toBe("GPU clearance not confirmed in case");
    const cpuComponent = v1Build.components.find((c) => c.category === "cpu");
    expect(cpuComponent?.unverified).toBe(false);

    // Version 2 has no matching validation (disclosed as unverified)
    const v2Build = versions[1].builds[0];
    expect(v2Build.validation).toBeNull();
    for (const comp of v2Build.components) {
      expect(comp.unverified).toBe(true);
      expect(comp.unverifiedNote).toBe("Unverified compatibility");
    }
  });

  it("renders version selector with unique ID to avoid DOM ID collisions", () => {
    const versions = findAllBuildVersions(sampleMessages, "INR");
    const markup = renderToStaticMarkup(
      <div>
        <BuildCard versions={versions} inSidePanel />
        <BuildCard versions={versions} inSidePanel />
      </div>
    );

    // Hardcoded ID must NOT be present
    expect(markup).not.toContain('id="build-version-select"');
    expect(markup).not.toContain('for="build-version-select"');

    // Each select and label must have matching generated IDs
    const selectMatches = [...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const labelMatches = [...markup.matchAll(/for="([^"]+)"/g)].map((m) => m[1]);

    expect(selectMatches.length).toBeGreaterThanOrEqual(2);
    expect(selectMatches[0]).not.toEqual(selectMatches[1]);
    expect(labelMatches[0]).toBe(selectMatches[0]);
    expect(labelMatches[1]).toBe(selectMatches[1]);
  });

  it("exact validation matching leaves build unverified when a different case is used", () => {
    const messagesWithDiffCase: ChatUIMessage[] = [
      {
        id: "msg-user-1",
        role: "user",
        parts: [{ type: "text", text: "Propose a build" }]
      },
      {
        id: "msg-asst-1",
        role: "assistant",
        parts: [
          {
            type: "tool-validate_build",
            toolCallId: "val-1",
            state: "output-available",
            input: {
              label: "NZXT Build",
              parts: {
                gpu: "RTX 4060 8GB",
                cpu: "Ryzen 5 7600",
                case: "NZXT H5 Flow"
              }
            },
            output: {
              valid: true,
              resolved: {},
              issues: [],
              checks: [],
              skipped_checks: []
            } as ValidationResult
          },
          {
            type: "tool-present_build",
            toolCallId: "call-1",
            state: "output-available",
            input: {
              builds: [
                {
                  label: "Corsair Case Build",
                  parts: [
                    { category: "gpu", name: "RTX 4060 8GB", price: 28500, currency: "INR" },
                    { category: "cpu", name: "Ryzen 5 7600", price: 18500, currency: "INR" },
                    { category: "case", name: "Corsair 4000D Airflow", price: 6500, currency: "INR" }
                  ]
                }
              ]
            },
            output: { presented: true }
          }
        ]
      }
    ];

    const versions = findAllBuildVersions(messagesWithDiffCase, "INR");
    expect(versions).toHaveLength(1);
    // Because the case differs (Corsair 4000D vs NZXT H5 Flow), validation MUST NOT match
    expect(versions[0].builds[0].validation).toBeNull();
    const caseComp = versions[0].builds[0].components.find((c) => c.category === "case");
    expect(caseComp?.unverified).toBe(true);
    expect(caseComp?.unverifiedNote).toBe("Unverified compatibility");
  });

  it("preserves severity on components: blocking conflicts are failed, not unverified", () => {
    const messagesWithConflict: ChatUIMessage[] = [
      {
        id: "msg-user-1",
        role: "user",
        parts: [{ type: "text", text: "Check compatibility" }]
      },
      {
        id: "msg-asst-1",
        role: "assistant",
        parts: [
          {
            type: "tool-validate_build",
            toolCallId: "val-conflict",
            state: "output-available",
            input: {
              label: "Conflict Build",
              parts: {
                cpu: "Ryzen 5 7600",
                ram: "DDR4 16GB"
              }
            },
            output: {
              valid: false,
              resolved: {},
              issues: [
                {
                  severity: "blocking",
                  rule: "ddr",
                  components: ["ram", "cpu"],
                  detail: "AM5 CPUs require DDR5 memory, but DDR4 was selected."
                }
              ],
              checks: [],
              skipped_checks: []
            } as ValidationResult
          },
          {
            type: "tool-present_build",
            toolCallId: "call-conflict",
            state: "output-available",
            input: {
              builds: [
                {
                  label: "Conflict Build",
                  parts: [
                    { category: "cpu", name: "Ryzen 5 7600", price: 18500, currency: "INR" },
                    { category: "ram", name: "DDR4 16GB", price: 3500, currency: "INR" }
                  ]
                }
              ]
            },
            output: { presented: true }
          }
        ]
      }
    ];

    const versions = findAllBuildVersions(messagesWithConflict, "INR");
    expect(versions).toHaveLength(1);
    const ramComp = versions[0].builds[0].components.find((c) => c.category === "ram");
    expect(ramComp?.failed).toBe(true);
    expect(ramComp?.unverified).toBe(false); // MUST NOT be marked unverified
    expect(ramComp?.failedNote).toBe("AM5 CPUs require DDR5 memory, but DDR4 was selected.");
  });

  it("validationStrip includes failed check counts in summary badge when failed > 0", () => {
    const failedValidation: ValidationResult = {
      valid: false,
      resolved: {},
      issues: [
        {
          severity: "blocking",
          rule: "socket",
          components: ["cpu", "motherboard"],
          detail: "LGA1700 CPU cannot fit AM5 socket."
        }
      ],
      summary: {
        passed: 6,
        failed: 1,
        unverified: 0,
        text: "1 check(s) failed · 6 passed · 0 unverified"
      }
    };

    const badges = validationStrip(failedValidation);
    const summaryBadge = badges.find((b) => b.label.includes("failed"));
    expect(summaryBadge).toBeDefined();
    expect(summaryBadge?.kind).toBe("blocking");
    expect(summaryBadge?.label).toBe("1 check failed · 6 passed");

    const blockingRuleBadge = badges.find((b) => b.label === "Socket");
    expect(blockingRuleBadge).toBeDefined();
    expect(blockingRuleBadge?.kind).toBe("blocking");
  });

  it("validationStrip includes failed, passed, and unverified counts together when both failed and unverified exist", () => {
    const mixedValidation: ValidationResult = {
      valid: false,
      resolved: {},
      issues: [
        {
          severity: "blocking",
          rule: "socket",
          components: ["cpu"],
          detail: "Socket mismatch"
        },
        {
          severity: "needs_verification",
          rule: "clearance",
          components: ["gpu"],
          detail: "Clearance unverified"
        }
      ],
      summary: {
        passed: 5,
        failed: 1,
        unverified: 1,
        text: "1 check(s) failed · 5 passed · 1 unverified"
      }
    };

    const badges = validationStrip(mixedValidation);
    const summaryBadge = badges.find((b) => b.label.includes("failed"));
    expect(summaryBadge).toBeDefined();
    expect(summaryBadge?.kind).toBe("blocking");
    expect(summaryBadge?.label).toBe("1 check failed · 5 passed · 1 unverified");
  });

  it("carries exact presentationId through onViewBuild when assistant message has multiple presentations", () => {
    const singleMessageMultiPresent: ChatUIMessage[] = [
      {
        id: "msg-user-1",
        role: "user",
        parts: [{ type: "text", text: "Propose a build" }]
      },
      {
        id: "msg-asst-1",
        role: "assistant",
        parts: [
          {
            type: "tool-present_build",
            toolCallId: "call-1",
            state: "output-available",
            input: {
              builds: [
                {
                  label: "Draft 1: Entry Level",
                  parts: [
                    { category: "gpu", name: "RTX 4060", price: 28000, currency: "INR" },
                    { category: "cpu", name: "Ryzen 5 5600", price: 11000, currency: "INR" }
                  ]
                }
              ]
            },
            output: { presented: true }
          },
          {
            type: "tool-present_build",
            toolCallId: "call-2",
            state: "output-available",
            input: {
              builds: [
                {
                  label: "Draft 2: Mid Range",
                  parts: [
                    { category: "gpu", name: "RTX 4070", price: 54000, currency: "INR" },
                    { category: "cpu", name: "Ryzen 5 7600", price: 18000, currency: "INR" }
                  ]
                }
              ]
            },
            output: { presented: true }
          }
        ]
      }
    ];

    const versions = findAllBuildVersions(singleMessageMultiPresent, "INR");
    expect(versions).toHaveLength(2);
    expect(versions[0].presentationId).toBe("call-1");
    expect(versions[1].presentationId).toBe("call-2");

    // Both presentation cards render with their distinct labels and totals
    const markup = renderToStaticMarkup(
      <MessageView
        message={singleMessageMultiPresent[1]}
        versions={versions}
        currency="INR"
      />
    );

    expect(markup).toContain("Draft 1: Entry Level");
    expect(markup).toContain("Draft 2: Mid Range");
    expect(markup).toContain("₹39,000");
    expect(markup).toContain("₹72,000");

    // Clicking either presentation card passes presentationId to select the exact version
    const selectedVersions: number[] = [];
    const onViewBuild = (_builds: unknown, versionOrId?: number | string) => {
      if (typeof versionOrId === "string") {
        const matched = versions.find((v) => v.presentationId === versionOrId);
        if (matched) selectedVersions.push(matched.version);
      }
    };

    // Simulate clicking call-2 presentation
    onViewBuild(versions[1].builds, versions[1].presentationId);
    expect(selectedVersions).toEqual([2]);

    // Simulate clicking call-1 presentation
    onViewBuild(versions[0].builds, versions[0].presentationId);
    expect(selectedVersions).toEqual([2, 1]);
  });
});



