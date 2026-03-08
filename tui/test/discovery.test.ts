import { describe, expect, it } from "vitest";
import { discoverWorkspaces } from "../src/io/discovery.js";

describe("discoverWorkspaces", () => {
  it("flattens grouped config entries and carries metadata", async () => {
    const refs = await discoverWorkspaces({
      groups: [
        {
          group: "apischeduler",
          "container-debug-path": "/opt/app/.cursor/",
          "docker-service": "apischeduler",
          paths: [
            {
              name: "APISCHEDULER-BACKEND-M",
              path: "/tmp/apischeduler-main",
            },
            {
              name: "APISCHEDULER-BACKEND-0",
              path: "/tmp/apischeduler-wt-0",
            },
          ],
        },
      ],
    });

    expect(refs).toHaveLength(2);
    expect(refs[0]?.group).toBe("apischeduler");
    expect(refs[0]?.name).toBe("APISCHEDULER-BACKEND-M");
    expect(refs[0]?.metadata["container-debug-path"]).toBe("/opt/app/.cursor/");
    expect(refs[0]?.metadata["docker-service"]).toBe("apischeduler");
  });
});
