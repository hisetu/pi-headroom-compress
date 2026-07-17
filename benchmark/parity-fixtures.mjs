export const parityFixtures = [
  {
    name: "json-object-array",
    content: JSON.stringify(Array.from({ length: 30 }, (_, index) => ({
      id: index,
      file: `src/module-${index}.ts`,
      message: index === 17 ? "CRITICAL_MARKER" : `result-${index}`,
    })), null, 2),
    required: ["src/module-0.ts", "CRITICAL_MARKER", "src/module-29.ts"],
  },
  {
    name: "git-diff",
    content: `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,5 +10,6 @@ export function run() {
 const before = true;
-oldCall();
+newCall();
+audit("CRITICAL_MARKER");
 return before;
 }
`,
    required: ["src/app.ts", "-oldCall()", "+newCall()", "CRITICAL_MARKER"],
  },
  {
    name: "html-document",
    content: `<!doctype html><html><head><title>Parity</title><style>.hidden{display:none}</style></head><body><nav>Navigation noise</nav><main><h1>CRITICAL_MARKER</h1><p>Important article body.</p></main><script>console.log("noise")</script></body></html>`,
    required: ["CRITICAL_MARKER", "Important article body"],
  },
  {
    name: "csv-table",
    content: [
      "id,name,status,owner",
      ...Array.from({ length: 25 }, (_, index) => `${index},item-${index},${index === 13 ? "CRITICAL_MARKER" : "ok"},team-${index % 3}`),
    ].join("\n"),
    required: ["id,name,status,owner", "CRITICAL_MARKER"],
  },
  {
    name: "ripgrep-search",
    content: Array.from({ length: 60 }, (_, index) =>
      `src/module-${index % 8}.ts:${index + 1}: ${index === 31 ? "ERROR CRITICAL_MARKER" : "handleRequest(input)"}`
    ).join("\n"),
    required: ["src/module-0.ts", "handleRequest", "CRITICAL_MARKER"],
  },
  {
    name: "build-log",
    content: Array.from({ length: 100 }, (_, index) => {
      if (index === 42) return "ERROR CRITICAL_MARKER: compilation failed";
      if (index === 43) return "    at compile (src/compiler.ts:99:3)";
      if (index === 80) return "WARNING: deprecated option";
      return `[12:00:${String(index % 60).padStart(2, "0")}] INFO compiling module-${index}`;
    }).join("\n"),
    required: ["CRITICAL_MARKER", "src/compiler.ts:99", "deprecated option"],
  },
  {
    name: "python-source",
    content: `import json

class Processor:
    """Important processor."""

    def process(self, items):
        result = []
        for item in items:
            if item.get("critical"):
                result.append("CRITICAL_MARKER")
            else:
                result.append(item.get("name"))
        return result

    def validate(self, value):
        if value is None:
            raise ValueError("value required")
        return True
`,
    required: ["class Processor", "def process", "def validate"],
  },
  {
    name: "cpp-source",
    content: `#include <iostream>
#include <vector>

class Processor {
public:
    std::vector<int> process(const std::vector<int>& values) {
        std::vector<int> result;
        for (int value : values) {
            if (value == 42) std::cout << "CRITICAL_MARKER";
            result.push_back(value * 2);
        }
        return result;
    }
};
`,
    required: ["class Processor", "process", "CRITICAL_MARKER"],
  },
  {
    name: "plain-documentation",
    content: Array.from({ length: 35 }, (_, index) =>
      `Section ${index}. This documentation explains architecture, deployment, monitoring, and recovery. ${index === 20 ? "CRITICAL_MARKER must be retained." : "Use deterministic configuration."}`
    ).join("\n\n"),
    required: ["Section 0", "CRITICAL_MARKER", "Section 34"],
  },
];
