import type { AgentRecord } from "@pomtree/core";

const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const DRIVER = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/;

// Operator configuration, not workflow input. Grants bind actual reviewed coordinator drivers to exact templates;
// neither children nor input-provided authorization identifiers inherit a blanket permission.
export class WorkflowRuntimePolicy {
  private readonly owners: Set<string>;
  private readonly grants: Map<string, Set<string>>;
  constructor(reviewed = "", templateJson = "{}") {
    const owners = reviewed
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (owners.some((name) => !NAME.test(name)) || new Set(owners).size !== owners.length) throw new Error("invalid POMTREED_WORKFLOW_REVIEWED_EXTENSIONS");
    this.owners = new Set(owners);
    let value: unknown;
    try {
      value = JSON.parse(templateJson);
    } catch {
      throw new Error("invalid POMTREED_WORKFLOW_TEMPLATES JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("POMTREED_WORKFLOW_TEMPLATES must map qualified workflows to template arrays");
    this.grants = new Map();
    for (const [driver, templates] of Object.entries(value)) {
      if (!DRIVER.test(driver) || !this.owners.has(driver.split("/")[0]!))
        throw new Error(`workflow template grant requires a reviewed qualified driver: ${driver}`);
      if (!Array.isArray(templates) || templates.some((id) => typeof id !== "string" || !NAME.test(id)) || new Set(templates).size !== templates.length)
        throw new Error(`invalid exact template grant for ${driver}`);
      this.grants.set(driver, new Set(templates));
    }
  }
  reviewed(owner: string): boolean {
    return this.owners.has(owner);
  }
  async validate(registered: readonly string[], resolveTemplate: (id: string) => Promise<unknown>): Promise<void> {
    const drivers = new Set(registered);
    for (const [driver, templates] of this.grants) {
      if (!drivers.has(driver)) throw new Error(`workflow template grant names an unregistered driver: ${driver}`);
      for (const id of templates) if (!(await resolveTemplate(id))) throw new Error(`workflow template grant names an unknown template: ${id}`);
    }
  }
  allows(requester: AgentRecord | null, template: string, registered: readonly string[]): boolean {
    return (
      !!requester &&
      requester.executor === "deterministic" &&
      !["exited", "reaped"].includes(requester.state) &&
      this.owners.has(requester.spec.driver.split("/")[0]!) &&
      registered.includes(requester.spec.driver) &&
      this.grants.get(requester.spec.driver)?.has(template) === true
    );
  }
}
